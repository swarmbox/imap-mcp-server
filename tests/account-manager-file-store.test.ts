import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  AccountStoreConfigError,
  AccountStoreReadOnlyError,
} from '../src/services/account-file-store.js';

// Real filesystem tests (no fs mock) for AccountManager in per-account file
// store mode (IMAP_ACCOUNTS_DIR + IMAP_ACCOUNTS). HOME points at a temp dir so
// any ~/.imap-mcp access lands there, and the store lives in a sibling temp dir.
// POSIX-only: the loader requires mode-600 files and Windows has no such bits.
const runOnPosix = process.platform === 'win32' ? describe.skip : describe;

const ENV_PASSWORD_VAR = 'IMAP_MCP_ACCOUNT_ACME_MAIL_IMAP_PASSWORD';
const SAVED_ENV = ['HOME', 'IMAP_ACCOUNTS_DIR', 'IMAP_ACCOUNTS', ENV_PASSWORD_VAR] as const;

const ACME = {
  name: 'Acme Mail',
  host: 'imap.example.com',
  port: 993,
  user: 'user@example.com',
  password: 'test-password',
  tls: true,
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'user@example.com',
    password: 'smtp-test-password',
  },
};

const OTHER_CO = {
  name: 'Other Co',
  host: 'imap.example.com',
  port: 993,
  user: 'other@example.com',
  password: 'REPLACE_ME',
  tls: true,
};

const NEW_ACCOUNT = {
  name: 'New',
  host: 'imap.example.com',
  port: 993,
  user: 'new@example.com',
  password: 'REPLACE_ME',
  tls: true,
};

runOnPosix('AccountManager file-store mode', () => {
  let tmpRoot: string;
  let home: string;
  let storeDir: string;
  let savedEnv: Record<string, string | undefined>;

  const imapMcpDir = () => path.join(home, '.imap-mcp');

  async function writeAccountFile(slug: string, body: object): Promise<string> {
    const file = path.join(storeDir, `imap-${slug}.json`);
    await fsp.writeFile(file, JSON.stringify(body, null, 2), { mode: 0o600 });
    await fsp.chmod(file, 0o600); // the umask can narrow but never widen; be explicit
    return file;
  }

  function useStore(slugs: string): void {
    process.env.IMAP_ACCOUNTS_DIR = storeDir;
    process.env.IMAP_ACCOUNTS = slugs;
  }

  // Dynamic import after env is set; the constructor reads env each time.
  async function newManager() {
    const { AccountManager } = await import('../src/services/account-manager.js');
    return new AccountManager();
  }

  beforeEach(async () => {
    savedEnv = Object.fromEntries(SAVED_ENV.map((k) => [k, process.env[k]]));
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-store-'));
    home = path.join(tmpRoot, 'home');
    storeDir = path.join(tmpRoot, 'store');
    await fsp.mkdir(home, { mode: 0o700 });
    await fsp.mkdir(storeDir, { mode: 0o700 });
    // AccountManager derives ~/.imap-mcp from os.homedir(), which honours $HOME.
    process.env.HOME = home;
    delete process.env.IMAP_ACCOUNTS_DIR;
    delete process.env.IMAP_ACCOUNTS;
    delete process.env[ENV_PASSWORD_VAR];
  });

  afterEach(async () => {
    for (const key of SAVED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('manager-store-reads-plaintext — getAccount, getAllAccounts and getAccountByName return file credentials', async () => {
    await writeAccountFile('acme', ACME);
    useStore('acme');
    const manager = await newManager();

    expect(manager.isFileStore).toBe(true);
    expect(manager.accountsDir).toBe(storeDir);

    const byId = manager.getAccount('acme');
    const all = manager.getAllAccounts();
    const byName = manager.getAccountByName('Acme Mail');

    expect(all).toHaveLength(1);
    for (const account of [byId, all[0], byName]) {
      expect(account?.id).toBe('acme');
      expect(account?.user).toBe('user@example.com');
      expect(account?.password).toBe('test-password');
      expect(account?.smtp?.password).toBe('smtp-test-password');
    }
  });

  it('manager-store-default-account — the single listed account is the default; unlisted files are invisible', async () => {
    await writeAccountFile('acme', ACME);
    await writeAccountFile('other-co', OTHER_CO);
    useStore('acme');
    const manager = await newManager();

    expect(manager.resolveAccountId()).toBe('acme');
    expect(() => manager.resolveAccountId('other-co')).toThrow('Account other-co not found');
    expect(manager.getAllAccounts()).toHaveLength(1);
  });

  it('manager-store-mutators-read-only — add, update and remove reject without touching the map or disk', async () => {
    const file = await writeAccountFile('acme', ACME);
    useStore('acme');
    const manager = await newManager();
    const bytesBefore = readFileSync(file);
    const filesBefore = await fsp.readdir(storeDir);
    const accountBefore = manager.getAccount('acme');

    const attempts = [
      () => manager.addAccount(NEW_ACCOUNT),
      () => manager.updateAccount('acme', { password: 'changed' }),
      () => manager.removeAccount('acme'),
    ];
    for (const attempt of attempts) {
      const result = attempt();
      await expect(result).rejects.toBeInstanceOf(AccountStoreReadOnlyError);
      await expect(result).rejects.toThrow(/IMAP_ACCOUNTS_DIR/);
      await expect(result).rejects.toThrow(storeDir);
    }

    expect(readFileSync(file).equals(bytesBefore)).toBe(true);
    expect(await fsp.readdir(storeDir)).toEqual(filesBefore);
    expect(manager.getAccount('acme')).toEqual(accountBefore);
    expect(manager.getAllAccounts()).toHaveLength(1);
  });

  it('manager-store-never-touches-imap-mcp — construction, reads and mutators leave ~/.imap-mcp absent', async () => {
    await writeAccountFile('acme', ACME);
    useStore('acme');
    expect(existsSync(imapMcpDir())).toBe(false);

    const manager = await newManager();
    manager.getAccount('acme');
    manager.getAllAccounts();
    manager.getAccountByName('Acme Mail');
    manager.resolveAccountId();
    manager.resolveAccountId('acme');
    manager.resolveAccountId(undefined, 'Acme Mail');
    await manager.addAccount(NEW_ACCOUNT).catch(() => undefined);
    await manager.updateAccount('acme', { password: 'changed' }).catch(() => undefined);
    await manager.removeAccount('acme').catch(() => undefined);

    expect(existsSync(imapMcpDir())).toBe(false);
  });

  it('manager-store-ignores-stray-accounts-json — a legacy ~/.imap-mcp store is never visible', async () => {
    // A legacy-mode manager writes ~/.imap-mcp/.key + accounts.json first.
    const legacy = await newManager();
    const legacyAccount = await legacy.addAccount({ ...NEW_ACCOUNT, name: 'Legacy' });
    expect(existsSync(path.join(imapMcpDir(), 'accounts.json'))).toBe(true);
    expect(existsSync(path.join(imapMcpDir(), '.key'))).toBe(true);

    await writeAccountFile('acme', ACME);
    useStore('acme');
    const manager = await newManager();

    expect(manager.getAccount('acme')?.password).toBe('test-password');
    expect(manager.resolveAccountId()).toBe('acme');
    const all = manager.getAllAccounts();
    expect(all.map((a) => a.id)).toEqual(['acme']);
    expect(all.some((a) => a.name === 'Legacy')).toBe(false);
    expect(manager.getAccount(legacyAccount.id)).toBeUndefined();
    expect(manager.getAccountByName('Legacy')).toBeUndefined();
    expect(() => manager.resolveAccountId(legacyAccount.id)).toThrow('not found');
  });

  it('manager-store-env-overrides — IMAP_MCP_ACCOUNT_* fills an empty password and is removed from process.env', async () => {
    await writeAccountFile('acme', { ...ACME, password: '' });
    useStore('acme');
    process.env[ENV_PASSWORD_VAR] = 'from-env';

    const manager = await newManager();

    expect(manager.getAccount('acme')?.password).toBe('from-env');
    expect(process.env[ENV_PASSWORD_VAR]).toBeUndefined();
  });

  describe('manager-store-config-errors-throw', () => {
    async function expectConstructorConfigError(): Promise<void> {
      let caught: unknown;
      try {
        await newManager();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AccountStoreConfigError);
    }

    it('manager-store-config-errors-throw — IMAP_ACCOUNTS_DIR set, IMAP_ACCOUNTS unset', async () => {
      process.env.IMAP_ACCOUNTS_DIR = storeDir;
      await expectConstructorConfigError();
    });

    it('manager-store-config-errors-throw — listed slug has no file', async () => {
      useStore('missing');
      await expectConstructorConfigError();
    });

    it('manager-store-config-errors-throw — IMAP_ACCOUNTS set, IMAP_ACCOUNTS_DIR unset', async () => {
      process.env.IMAP_ACCOUNTS = 'acme';
      await expectConstructorConfigError();
    });
  });

  it('manager-legacy-when-unset — without IMAP_ACCOUNTS_DIR the encrypted ~/.imap-mcp store is used as today', async () => {
    const manager = await newManager();

    expect(manager.isFileStore).toBe(false);
    expect(manager.accountsDir).toBeUndefined();

    const added = await manager.addAccount({ ...NEW_ACCOUNT, password: 'topsecret' });

    const accountsJson = path.join(imapMcpDir(), 'accounts.json');
    const keyFile = path.join(imapMcpDir(), '.key');
    expect(statSync(accountsJson).isFile()).toBe(true);
    expect(statSync(keyFile).isFile()).toBe(true);
    // Stored encrypted, returned decrypted.
    expect(readFileSync(accountsJson, 'utf-8')).not.toContain('topsecret');
    expect(manager.getAccount(added.id)?.password).toBe('topsecret');
  });
});
