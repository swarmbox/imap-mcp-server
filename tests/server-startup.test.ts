import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fsp, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// End-to-end: boot the real entry point (src/index.ts via tsx) as a child
// process. The env is explicit and minimal -- never spread process.env -- so no
// developer IMAP_* variable leaks in, and cwd is a temp dir so no repo .env is
// picked up by dotenv. POSIX-only: the store loader requires mode-600 files.
const runOnPosix = process.platform === 'win32' ? describe.skip : describe;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO, 'node_modules/.bin/tsx');
const ENTRY = path.join(REPO, 'src/index.ts');
const TIMEOUT = 30_000;

const MUTATORS = ['imap_add_account', 'imap_update_account', 'imap_remove_account'];

const ACME = {
  name: 'Acme Mail',
  host: 'imap.example.com',
  port: 993,
  user: 'user@example.com',
  password: 'test-password',
  tls: true,
};
const OTHER_CO = { ...ACME, name: 'Other Co', user: 'other@example.com' };

interface Child {
  proc: ChildProcess;
  stderr: () => string;
  exited: Promise<number | null>;
  /** Resolves with the JSON-RPC response carrying `id`; blank lines are skipped. */
  response: (id: number) => Promise<any>;
  send: (message: object) => void;
}

runOnPosix('server startup (child process)', () => {
  let tmpRoot: string;
  let children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children) {
      try {
        // Kill the whole group: the .bin/tsx wrapper spawns the real server.
        process.kill(-child.pid!, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    children = [];
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  async function makeDirs() {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-startup-'));
    const home = path.join(tmpRoot, 'home');
    const store = path.join(tmpRoot, 'store');
    const cwd = path.join(tmpRoot, 'cwd');
    for (const dir of [home, store, cwd]) await fsp.mkdir(dir, { mode: 0o700 });
    return { home, store, cwd };
  }

  async function writeAccount(store: string, slug: string, body: object) {
    const file = path.join(store, `imap-${slug}.json`);
    await fsp.writeFile(file, JSON.stringify(body, null, 2), { mode: 0o600 });
    await fsp.chmod(file, 0o600);
  }

  function startServer(home: string, cwd: string, imapEnv: Record<string, string>): Child {
    const proc = spawn(TSX, [ENTRY], {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: home, ...imapEnv },
    });
    children.push(proc);

    let stderr = '';
    proc.stderr!.on('data', (chunk) => (stderr += chunk));

    const exited = new Promise<number | null>((resolve) => proc.on('close', (code) => resolve(code)));

    const waiting = new Map<number, (message: any) => void>();
    const seen = new Map<number, any>();
    let buffered = '';
    proc.stdout!.on('data', (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        const resolve = waiting.get(message.id);
        if (resolve) resolve(message);
        else seen.set(message.id, message);
      }
    });

    return {
      proc,
      stderr: () => stderr,
      exited,
      send: (message) => proc.stdin!.write(JSON.stringify(message) + '\n'),
      response: (id) =>
        seen.has(id)
          ? Promise.resolve(seen.get(id))
          : new Promise((resolve) => waiting.set(id, resolve)),
    };
  }

  it('server-config-error-exits-cleanly — a bad store config exits 1 with one stderr line and no stack', async () => {
    const { home, store, cwd } = await makeDirs();
    const child = startServer(home, cwd, { IMAP_ACCOUNTS_DIR: store });

    const code = await child.exited;

    expect(code).toBe(1);
    expect(child.stderr()).toContain(
      '[imap-mcp] Account store configuration error: IMAP_ACCOUNTS_DIR is set, so IMAP_ACCOUNTS'
    );
    expect(child.stderr()).not.toContain('    at ');
  }, TIMEOUT);

  it('server-store-mode-end-to-end — lists only the allow-listed account and hides the account mutators', async () => {
    const { home, store, cwd } = await makeDirs();
    await writeAccount(store, 'acme', ACME);
    await writeAccount(store, 'other-co', OTHER_CO); // valid but unlisted
    const child = startServer(home, cwd, { IMAP_ACCOUNTS_DIR: store, IMAP_ACCOUNTS: 'acme' });

    child.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '0.0.0' },
      },
    });
    const init = await child.response(1);
    expect(init.result.serverInfo.name).toBe('imap-mcp-server');

    child.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    child.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    child.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'imap_list_accounts', arguments: {} },
    });

    const tools = (await child.response(2)).result.tools.map((t: { name: string }) => t.name);
    for (const name of MUTATORS) expect(tools).not.toContain(name);
    expect(tools).toContain('imap_list_accounts');

    const call = (await child.response(3)).result;
    const { accounts } = JSON.parse(call.content[0].text);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('acme');

    expect(child.stderr()).toContain(`[imap-mcp] Account store: 1 account(s) from ${store} (ids: acme)`);
    expect(existsSync(path.join(home, '.imap-mcp'))).toBe(false);
  }, TIMEOUT);
});
