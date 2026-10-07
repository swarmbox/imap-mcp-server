import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import { WebUIServer } from '../src/web/server.js';

// The setup wizard is unchanged in store mode: its add/edit/delete routes reach
// the AccountManager mutators, which throw the read-only error and surface as a
// 400. Real filesystem and a real store-mode AccountManager (HOME and the store
// are temp dirs). POSIX-only: the loader requires mode-600 files.
const runOnPosix = process.platform === 'win32' ? describe.skip : describe;

const SAVED_ENV = ['HOME', 'IMAP_ACCOUNTS_DIR', 'IMAP_ACCOUNTS'] as const;
const PASSWORD = 'test-password';
const ACME = {
  name: 'Acme Mail',
  host: 'imap.example.com',
  port: 993,
  user: 'user@example.com',
  password: PASSWORD,
  tls: true,
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

runOnPosix('Web wizard in file-store mode', () => {
  let tmpRoot: string;
  let storeFile: string;
  let storeBytes: Buffer;
  let httpServer: Server;
  let baseUrl: string;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    savedEnv = Object.fromEntries(SAVED_ENV.map((k) => [k, process.env[k]]));
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-wizard-store-'));
    const home = path.join(tmpRoot, 'home');
    const storeDir = path.join(tmpRoot, 'store');
    await fsp.mkdir(home, { mode: 0o700 });
    await fsp.mkdir(storeDir, { mode: 0o700 });

    storeFile = path.join(storeDir, 'imap-acme.json');
    await fsp.writeFile(storeFile, JSON.stringify(ACME, null, 2), { mode: 0o600 });
    await fsp.chmod(storeFile, 0o600);
    storeBytes = await fsp.readFile(storeFile);

    // AccountManager derives ~/.imap-mcp from os.homedir(), which honours $HOME.
    process.env.HOME = home;
    process.env.IMAP_ACCOUNTS_DIR = storeDir;
    process.env.IMAP_ACCOUNTS = 'acme';

    const { AccountManager } = await import('../src/services/account-manager.js');
    const wizard = new WebUIServer(0, {
      accountManager: new AccountManager(),
      imapService: {} as any,
    });
    await new Promise<void>((resolve) => {
      httpServer = wizard.getApp().listen(0, () => resolve());
    });
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    httpServer?.close();
    for (const key of SAVED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('wizard-store-routes-read-only — add, edit and delete return 400 naming IMAP_ACCOUNTS_DIR; listing still works', async () => {
    const add = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: 'New',
        host: 'imap.example.com',
        email: 'new@example.com',
        password: 'REPLACE_ME',
      }),
    });
    const edit = await fetch(`${baseUrl}/api/accounts/acme`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const remove = await fetch(`${baseUrl}/api/accounts/acme`, { method: 'DELETE' });

    for (const res of [add, edit, remove]) {
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('IMAP_ACCOUNTS_DIR');
    }

    const list = await fetch(`${baseUrl}/api/accounts`);
    expect(list.ok).toBe(true);
    const raw = await list.text();
    expect(raw).not.toContain(PASSWORD);
    const accounts = JSON.parse(raw);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acme');
    expect(accounts[0].name).toBe('Acme Mail');
    expect(accounts[0].password).toBeUndefined();

    expect((await fsp.readFile(storeFile)).equals(storeBytes)).toBe(true);
  });
});
