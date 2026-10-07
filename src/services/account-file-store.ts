import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ImapAccount } from '../types/index.js';

/**
 * Per-account file store: when `IMAP_ACCOUNTS_DIR` is set, accounts come from
 * one plaintext JSON file per allow-listed slug (`imap-<slug>.json`) instead of
 * the encrypted `~/.imap-mcp/accounts.json`. Everything here is pure (config
 * resolution) or read-only (loading); nothing is ever written.
 *
 * Error messages name the slug, path, field and octal mode only — never a value
 * read from a file — so a misconfigured store cannot leak a credential to stderr.
 */

export type AccountStoreConfig =
  | { kind: 'legacy' }
  | { kind: 'files'; dir: string; slugs: string[] };

/** Startup configuration problem. Aborts the server before the stdio handshake. */
export class AccountStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountStoreConfigError';
  }
}

/** Raised by account mutations while accounts are file-managed. */
export class AccountStoreReadOnlyError extends Error {
  constructor(dir: string) {
    super(
      `Accounts are file-managed in ${dir} (IMAP_ACCOUNTS_DIR). Edit imap-<slug>.json and restart the server.`,
    );
    this.name = 'AccountStoreReadOnlyError';
  }
}

/** Lowercase alphanumeric runs joined by single hyphens; also rules out path traversal. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Decide between the legacy encrypted store and the per-account file store
 * from `IMAP_ACCOUNTS_DIR` / `IMAP_ACCOUNTS`. Reads only `env` and `os.homedir()`.
 */
export function resolveAccountStoreConfig(env: NodeJS.ProcessEnv = process.env): AccountStoreConfig {
  const rawDir = env.IMAP_ACCOUNTS_DIR ?? '';
  const rawAccounts = env.IMAP_ACCOUNTS ?? '';

  if (!rawDir) {
    if (rawAccounts) {
      throw new AccountStoreConfigError(
        'IMAP_ACCOUNTS is set but IMAP_ACCOUNTS_DIR is not; the allow-list only applies to the per-account store',
      );
    }
    return { kind: 'legacy' };
  }

  const slugs = [...new Set(rawAccounts.split(',').map((s) => s.trim()).filter(Boolean))];
  if (slugs.length === 0) {
    throw new AccountStoreConfigError(
      'IMAP_ACCOUNTS_DIR is set, so IMAP_ACCOUNTS (comma-separated account slugs) is required',
    );
  }
  for (const slug of slugs) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new AccountStoreConfigError(
        `invalid account slug "${slug}" in IMAP_ACCOUNTS (use lowercase letters, digits and single hyphens)`,
      );
    }
  }

  const expanded = rawDir.startsWith('~/') ? path.join(os.homedir(), rawDir.slice(2)) : rawDir;
  return { kind: 'files', dir: path.resolve(expanded), slugs };
}

/**
 * Load `imap-<slug>.json` from `dir` for each slug, in order. The directory is
 * never listed, so unlisted files are never opened. Returns plaintext accounts
 * whose `id` is the slug; any problem throws `AccountStoreConfigError`.
 */
export function loadAccountFiles(dir: string, slugs: string[]): ImapAccount[] {
  const accounts = slugs.map((slug) => loadAccountFile(dir, slug));

  // Name resolution and env overrides are keyed by name, so names must be unique.
  const slugByName = new Map<string, string>();
  for (const account of accounts) {
    const other = slugByName.get(account.name);
    if (other !== undefined) {
      throw new AccountStoreConfigError(
        `accounts "${other}" and "${account.id}" share name; each account file needs a unique "name"`,
      );
    }
    slugByName.set(account.name, account.id);
  }
  return accounts;
}

function loadAccountFile(dir: string, slug: string): ImapAccount {
  const file = path.join(dir, `imap-${slug}.json`);
  const fail = (problem: string): never => {
    throw new AccountStoreConfigError(`account "${slug}": ${problem}`);
  };

  // statSync follows symlinks, so a symlink to a mode-600 file is accepted.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(code === 'ENOENT' ? `file not found at ${file}` : `cannot stat ${file} (${code})`);
  }
  if (!stat.isFile()) fail(`${file} is not a regular file`);

  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    const mode = (stat.mode & 0o777).toString(8);
    fail(`${file} must be mode 600 (is ${mode}); run: chmod 600 ${file}`);
  }

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return fail(`cannot read ${file} (${(error as NodeJS.ErrnoException).code})`);
  }

  // JSON.parse's own message can quote input text (and so a password); drop it.
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(`invalid JSON in ${file}`);
  }

  if (!isPlainObject(body)) return fail(`${file} must contain a JSON object`);

  const fieldError = validateAccountFields(body);
  if (fieldError) fail(`${fieldError} in ${file}`);

  return { ...(body as unknown as ImapAccount), id: slug };
}

/** Returns a description of the first invalid field, or `undefined` when valid. */
function validateAccountFields(body: Record<string, unknown>): string | undefined {
  for (const field of ['name', 'host']) {
    if (typeof body[field] !== 'string' || body[field] === '') {
      return `field "${field}" must be a non-empty string`;
    }
  }
  if (!isInteger(body.port) || body.port < 1 || body.port > 65535) {
    return 'field "port" must be an integer from 1 to 65535';
  }
  // Empty strings are allowed: they mark credentials supplied via env variables.
  for (const field of ['user', 'password']) {
    if (typeof body[field] !== 'string') return `field "${field}" must be a string`;
  }
  if (typeof body.tls !== 'boolean') return 'field "tls" must be a boolean';

  if (!('smtp' in body)) return undefined;
  const smtp = body.smtp;
  if (!isPlainObject(smtp)) return 'field "smtp" must be an object';
  if (typeof smtp.host !== 'string') return 'field "smtp.host" must be a string';
  if (!isInteger(smtp.port)) return 'field "smtp.port" must be an integer';
  if (typeof smtp.secure !== 'boolean') return 'field "smtp.secure" must be a boolean';
  for (const field of ['user', 'password']) {
    if (field in smtp && typeof smtp[field] !== 'string') {
      return `field "smtp.${field}" must be a string`;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Startup guard for entry points: report an `AccountStoreConfigError` as one
 * stderr line and exit 1; rethrow anything else unchanged.
 */
export function exitOnAccountStoreConfigError(error: unknown): never {
  if (error instanceof AccountStoreConfigError) {
    console.error(`[imap-mcp] Account store configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
