import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import {
  AccountStoreConfigError,
  exitOnAccountStoreConfigError,
  loadAccountFiles,
  resolveAccountStoreConfig,
} from '../src/services/account-file-store.js';

// Real filesystem tests (no fs mock) for the per-account file store. Fixtures
// live in fs.mkdtemp dirs; permission cases are POSIX-only because Windows has
// no comparable mode bits.
const itPosix = process.platform === 'win32' ? it.skip : it;

const JULY_EXAMPLE = {
  name: 'Personal IMAP',
  host: 'imap.example.com',
  port: 993,
  user: 'user@example.com',
  password: 'REPLACE_ME',
  tls: true,
  email: 'user@example.com',
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'user@example.com',
    password: 'REPLACE_ME',
  },
  saveToSent: true,
};

const MINIMAL = {
  name: 'Acme',
  host: 'imap.example.com',
  port: 993,
  user: 'user@example.com',
  password: 'test-password',
  tls: false,
};

function expectConfigError(fn: () => unknown, ...fragments: string[]): AccountStoreConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AccountStoreConfigError);
  const err = caught as AccountStoreConfigError;
  expect(err.name).toBe('AccountStoreConfigError');
  for (const fragment of fragments) expect(err.message).toContain(fragment);
  return err;
}

describe('resolveAccountStoreConfig', () => {
  it('config-legacy-when-unset — both unset gives legacy', () => {
    expect(resolveAccountStoreConfig({})).toEqual({ kind: 'legacy' });
  });

  it('config-legacy-when-unset — both empty gives legacy', () => {
    expect(resolveAccountStoreConfig({ IMAP_ACCOUNTS_DIR: '', IMAP_ACCOUNTS: '' })).toEqual({
      kind: 'legacy',
    });
  });

  it('config-accounts-without-dir-fails — dir unset', () => {
    expectConfigError(
      () => resolveAccountStoreConfig({ IMAP_ACCOUNTS: 'acme' }),
      'IMAP_ACCOUNTS is set but IMAP_ACCOUNTS_DIR is not',
    );
  });

  it('config-accounts-without-dir-fails — dir empty', () => {
    expectConfigError(
      () => resolveAccountStoreConfig({ IMAP_ACCOUNTS_DIR: '', IMAP_ACCOUNTS: 'acme' }),
      'IMAP_ACCOUNTS is set but IMAP_ACCOUNTS_DIR is not',
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only commas', ' , ,'],
  ])('config-dir-without-accounts-fails — IMAP_ACCOUNTS %s', (_label, accounts) => {
    const env: NodeJS.ProcessEnv = { IMAP_ACCOUNTS_DIR: '/tmp/store' };
    if (accounts !== undefined) env.IMAP_ACCOUNTS = accounts;
    expectConfigError(
      () => resolveAccountStoreConfig(env),
      'IMAP_ACCOUNTS (comma-separated account slugs) is required',
    );
  });

  it('config-files-mode — absolute dir, slugs trimmed, de-duplicated, order kept', () => {
    const dir = path.resolve(os.tmpdir(), 'imap-store');
    expect(
      resolveAccountStoreConfig({ IMAP_ACCOUNTS_DIR: dir, IMAP_ACCOUNTS: ' acme, beta ,acme' }),
    ).toEqual({ kind: 'files', dir, slugs: ['acme', 'beta'] });
  });

  it('config-files-mode — relative dir resolves to an absolute path', () => {
    const config = resolveAccountStoreConfig({
      IMAP_ACCOUNTS_DIR: 'relative/store',
      IMAP_ACCOUNTS: 'acme,,beta',
    });
    expect(config).toEqual({
      kind: 'files',
      dir: path.resolve('relative/store'),
      slugs: ['acme', 'beta'],
    });
  });

  describe('config-tilde-expands', () => {
    let tmpHome: string;
    let prevHome: string | undefined;

    beforeEach(async () => {
      prevHome = process.env.HOME;
      tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-home-'));
      process.env.HOME = tmpHome;
    });

    afterEach(async () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fsp.rm(tmpHome, { recursive: true, force: true });
    });

    it('config-tilde-expands — leading ~/ expands to the home directory', () => {
      const config = resolveAccountStoreConfig({ IMAP_ACCOUNTS_DIR: '~/keys', IMAP_ACCOUNTS: 'acme' });
      expect(config).toEqual({ kind: 'files', dir: path.join(os.homedir(), 'keys'), slugs: ['acme'] });
    });
  });

  it.each(['../acme', 'Acme', 'a_b', '-a', 'a-', 'a/b'])(
    'config-invalid-slug-fails — rejects %s',
    (slug) => {
      expectConfigError(
        () => resolveAccountStoreConfig({ IMAP_ACCOUNTS_DIR: '/tmp/store', IMAP_ACCOUNTS: `beta,${slug}` }),
        'invalid account slug',
        `"${slug}"`,
      );
    },
  );
});

describe('loadAccountFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-store-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function writeAccount(slug: string, body: unknown, mode = 0o600): Promise<string> {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    return writeRaw(path.join(dir, `imap-${slug}.json`), text, mode);
  }

  async function writeRaw(file: string, text: string, mode = 0o600): Promise<string> {
    await fsp.writeFile(file, text, { mode });
    // umask may have narrowed or widened the create mode; pin it explicitly.
    await fsp.chmod(file, mode);
    return file;
  }

  it('load-july-schema-unchanged — July pinned example loads as-is with id from slug', async () => {
    await writeAccount('acme', JULY_EXAMPLE);
    const accounts = loadAccountFiles(dir, ['acme']);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({ ...JULY_EXAMPLE, id: 'acme' });
  });

  it('load-minimal-no-smtp — six required fields only', async () => {
    await writeAccount('acme', MINIMAL);
    const accounts = loadAccountFiles(dir, ['acme']);
    expect(accounts).toEqual([{ ...MINIMAL, id: 'acme' }]);
    expect(accounts[0]).not.toHaveProperty('smtp');
  });

  it('load-id-from-filename — body id is ignored', async () => {
    await writeAccount('acme', { ...MINIMAL, id: 'something-else' });
    const [account] = loadAccountFiles(dir, ['acme']);
    expect(account.id).toBe('acme');
  });

  it('load-unlisted-never-opened — malformed loose unlisted file is ignored', async () => {
    await writeAccount('acme', MINIMAL);
    await writeAccount('other-co', '{ not json', 0o644);
    const accounts = loadAccountFiles(dir, ['acme']);
    expect(accounts.map((a) => a.id)).toEqual(['acme']);
  });

  it('load-missing-file-fails — names the slug and the path', () => {
    expectConfigError(
      () => loadAccountFiles(dir, ['acme']),
      'account "acme"',
      'file not found',
      path.join(dir, 'imap-acme.json'),
    );
  });

  itPosix.each([
    ['644', 0o644],
    ['640', 0o640],
  ])('load-loose-mode-fails — mode %s is rejected', async (_label, mode) => {
    await writeAccount('acme', MINIMAL, mode);
    const err = expectConfigError(
      () => loadAccountFiles(dir, ['acme']),
      'account "acme"',
      'must be mode 600',
      `is ${mode.toString(8)}`,
      'chmod 600',
    );
    expect(err.message).not.toContain('test-password');
  });

  it('load-invalid-json-no-leak — parse error never echoes file contents', async () => {
    await writeAccount('acme', '{"name": "Acme", "password": PLANTED-SECRET-7f3a }');
    const err = expectConfigError(() => loadAccountFiles(dir, ['acme']), 'account "acme"', 'invalid JSON');
    expect(err.message).not.toContain('PLANTED-SECRET-7f3a');
    expect(String(err.stack)).not.toContain('PLANTED-SECRET-7f3a');
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"acme"'],
    ['null', 'null'],
  ])('load-non-object-fails — top level is %s', async (_label, text) => {
    await writeAccount('acme', text);
    expectConfigError(() => loadAccountFiles(dir, ['acme']), 'account "acme"');
  });

  const PASSWORD = 'PLANTED-PASSWORD-91c2';
  const requiredFieldCases: Array<[string, string, unknown]> = [
    ['name', 'empty', ''],
    ['name', 'absent', undefined],
    ['host', 'empty', ''],
    ['host', 'absent', undefined],
    ['port', 'a string', '993'],
    ['port', '0', 0],
    ['port', '65536', 65536],
    ['port', 'non-integer', 1.5],
    ['user', 'absent', undefined],
    ['user', 'a number', 42],
    ['password', 'absent', undefined],
    ['password', 'a number', 12345],
    ['tls', 'a string', 'true'],
    ['tls', 'absent', undefined],
  ];

  it.each(requiredFieldCases)(
    'load-required-field-invalid-fails — %s %s',
    async (field, _label, value) => {
      const body: Record<string, unknown> = { ...MINIMAL, password: PASSWORD };
      if (value === undefined) delete body[field];
      else body[field] = value;
      await writeAccount('acme', body);
      const err = expectConfigError(() => loadAccountFiles(dir, ['acme']), 'account "acme"', field);
      expect(err.message).not.toContain(PASSWORD);
    },
  );

  const smtpCases: Array<[string, unknown]> = [
    ['not an object (string)', 'smtp.example.com'],
    ['not an object (array)', []],
    ['not an object (null)', null],
    ['missing host', { port: 587, secure: false }],
    ['missing port', { host: 'smtp.example.com', secure: false }],
    ['missing secure', { host: 'smtp.example.com', port: 587 }],
    ['non-string user', { host: 'smtp.example.com', port: 587, secure: false, user: 42 }],
    ['non-string password', { host: 'smtp.example.com', port: 587, secure: false, password: 12345 }],
  ];

  it.each(smtpCases)('load-bad-smtp-fails — smtp %s', async (_label, smtp) => {
    await writeAccount('acme', { ...MINIMAL, password: PASSWORD, smtp });
    const err = expectConfigError(() => loadAccountFiles(dir, ['acme']), 'account "acme"', 'smtp');
    expect(err.message).not.toContain(PASSWORD);
  });

  it('load-empty-credentials-allowed — empty user/password are the env-managed marker', async () => {
    await writeAccount('acme', {
      ...MINIMAL,
      user: '',
      password: '',
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: '', password: '' },
    });
    const [account] = loadAccountFiles(dir, ['acme']);
    expect(account.user).toBe('');
    expect(account.password).toBe('');
    expect(account.smtp?.user).toBe('');
    expect(account.smtp?.password).toBe('');
  });

  it('load-extra-fields-pass-through — optional fields are copied unchanged', async () => {
    const extras = {
      allowStartTLS: false,
      sentFolder: 'Sent Items',
      defaultBcc: 'a@example.com',
      keepalive: true,
    };
    await writeAccount('acme', { ...MINIMAL, ...extras });
    const [account] = loadAccountFiles(dir, ['acme']);
    expect(account).toMatchObject(extras);
    expect(account).toEqual({ ...MINIMAL, ...extras, id: 'acme' });
  });

  itPosix('load-symlink-followed — symlink to a mode-600 file loads', async () => {
    const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-target-'));
    try {
      const target = await writeRaw(path.join(elsewhere, 'acme.json'), JSON.stringify(MINIMAL));
      await fsp.symlink(target, path.join(dir, 'imap-acme.json'));
      const accounts = loadAccountFiles(dir, ['acme']);
      expect(accounts).toEqual([{ ...MINIMAL, id: 'acme' }]);
    } finally {
      await fsp.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('load-duplicate-names-fails — two slugs sharing a name are rejected', async () => {
    await writeAccount('acme', { ...MINIMAL, name: 'Shared' });
    await writeAccount('beta', { ...MINIMAL, name: 'Shared' });
    expectConfigError(
      () => loadAccountFiles(dir, ['acme', 'beta']),
      'accounts "acme" and "beta" share name',
    );
  });
});

describe('exitOnAccountStoreConfigError', () => {
  const EXIT_SENTINEL = new Error('process.exit called');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exit-helper-exits-or-rethrows — config error prints one line and exits 1', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw EXIT_SENTINEL;
    });

    const configError = new AccountStoreConfigError('IMAP_ACCOUNTS_DIR is set, so IMAP_ACCOUNTS is required');
    expect(() => exitOnAccountStoreConfigError(configError)).toThrow(EXIT_SENTINEL);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line.startsWith('[imap-mcp] Account store configuration error:')).toBe(true);
    expect(line).toContain(configError.message);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exit-helper-exits-or-rethrows — other errors are rethrown unchanged', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw EXIT_SENTINEL;
    });

    const plain = new Error('boom');
    let caught: unknown;
    try {
      exitOnAccountStoreConfigError(plain);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(plain);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
