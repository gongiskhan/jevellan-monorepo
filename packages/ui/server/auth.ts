// Password sign-in of the jv ui server (brief section 7), the way Jevellan does it.
//
// - The password is the content of $JV_HOME/ui-password: 20 random base32 characters (RFC 4648 alphabet), written
//   once at the first start (mode 600, never overwritten except by --password-reset) and read again at every sign-in,
//   so a reset takes effect in a running server too. jv ui prints it once; nothing else ever does.
// - A sign-in sets the cookie jv_ui: 32 random bytes, base64url, HttpOnly, SameSite=Lax, Path=/, Max-Age 30 days, and
//   Secure when the request came over TLS (an encrypted socket, or X-Forwarded-Proto https from a proxy such as
//   tailscale serve). The store keeps only its sha256 (hex) in ui_tokens, with created_at, last_seen_at and the
//   user agent (cut to 200 characters).
// - A token is valid while last_seen_at is less than 30 days old, and using it refreshes last_seen_at (and the
//   cookie's Max-Age). The refresh is written at most every 5 minutes per token: every write moves PRAGMA data_version,
//   which sends every open page a `change` event, so a write per request would make pages refetch in a loop.
// - Nothing deletes a store row: signing out sets the token's last_seen_at to 1970-01-01T00:00:00.000Z, which is
//   expired, and a password reset does the same to every token (every browser signs in again).
// - Five wrong passwords from one address (the socket's remote address; forwarded headers are not trusted) within a
//   minute: every sign-in from it gets 429 for a minute after the fifth. A right password clears the count.
// - The password is compared as sha256 digests with timingSafeEqual; it never reaches a log, the store or a response.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { TLSSocket } from 'node:tls';
import { dirname, join } from 'node:path';
import { refused } from 'jevellan-core/errors';
import { paths } from 'jevellan-core/paths';

export const COOKIE_NAME = 'jv_ui';
export const PASSWORD_LENGTH = 20;
export const TOKEN_BYTES = 32;
export const TOKEN_VALID_MS = 30 * 24 * 60 * 60 * 1000;
export const TOKEN_REFRESH_MS = 5 * 60 * 1000;
export const SIGNED_OUT_AT = '1970-01-01T00:00:00.000Z';
export const USER_AGENT_MAX = 200;
export const LOGIN_FAILURES = 5;
export const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_BLOCK_MS = 60_000;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// ---- the password file ----------------------------------------------------------------------------------------

/** $JV_HOME/ui-password */
export function uiPasswordFile(): string {
  return join(paths.home, 'ui-password');
}

/** 20 random base32 characters (256 is a multiple of 32, so `byte & 31` is uniform). */
export function newPassword(): string {
  return [...randomBytes(PASSWORD_LENGTH)].map((b) => BASE32[b & 31]).join('');
}

export interface PasswordState {
  file: string;
  /** Set only when this call wrote a new password (jv ui prints it once). */
  created?: string;
}

function readPasswordFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Makes sure the password file exists (mode 600), creating it at the first start. Refuses an empty file. */
export function ensurePassword(file: string = uiPasswordFile()): PasswordState {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    const password = newPassword();
    try {
      writeFileSync(file, `${password}\n`, { mode: 0o600, flag: 'wx' });
      return { file, created: password };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // another jv ui wrote it first: use theirs
    }
  }
  const text = readPasswordFile(file);
  if (!text) throw refused(`${file} is empty or unreadable; jv ui --password-reset writes a new one`);
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  return { file };
}

/** Writes a new password (atomically, mode 600) and signs every browser out. Returns it, for jv ui to print once. */
export function resetPassword(db: DatabaseSync | undefined, file: string = uiPasswordFile()): PasswordState & { created: string } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const password = newPassword();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${password}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  if (db) signOutAll(db);
  return { file, created: password };
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Whether `given` is the password in the file (constant time over the digests). */
export function passwordMatches(given: unknown, file: string = uiPasswordFile()): boolean {
  if (typeof given !== 'string' || given === '') return false;
  const expected = readPasswordFile(file);
  if (!expected) return false;
  return timingSafeEqual(digest(given.trim()), digest(expected));
}

// ---- tokens -----------------------------------------------------------------------------------------------------

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new token, stored hashed. Returns the cookie value. */
export function issueToken(db: DatabaseSync, userAgent: string, now: number = Date.now()): string {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const at = new Date(now).toISOString();
  db.prepare('INSERT INTO ui_tokens (token_hash, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?)').run(
    tokenHash(token),
    at,
    at,
    userAgent.slice(0, USER_AGENT_MAX),
  );
  return token;
}

export interface TokenCheck {
  valid: boolean;
  /** last_seen_at was moved to now (the cookie is sent again with a fresh Max-Age). */
  refreshed: boolean;
}

/** Whether a cookie value is a live token; refreshes last_seen_at when it is older than TOKEN_REFRESH_MS. */
export function checkToken(db: DatabaseSync, token: string | undefined, now: number = Date.now()): TokenCheck {
  if (!token || !TOKEN_SHAPE.test(token)) return { valid: false, refreshed: false };
  const hash = tokenHash(token);
  const row = db.prepare('SELECT last_seen_at FROM ui_tokens WHERE token_hash = ?').get(hash) as { last_seen_at?: string } | undefined;
  const seen = row?.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
  if (!Number.isFinite(seen) || now - seen >= TOKEN_VALID_MS) return { valid: false, refreshed: false };
  if (now - seen < TOKEN_REFRESH_MS) return { valid: true, refreshed: false };
  db.prepare('UPDATE ui_tokens SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), hash);
  return { valid: true, refreshed: true };
}

/** Signs one token out (expires it; the row stays). */
export function signOut(db: DatabaseSync, token: string | undefined): void {
  if (!token || !TOKEN_SHAPE.test(token)) return;
  db.prepare('UPDATE ui_tokens SET last_seen_at = ? WHERE token_hash = ?').run(SIGNED_OUT_AT, tokenHash(token));
}

/** Signs every token out (a password reset). */
export function signOutAll(db: DatabaseSync): void {
  db.prepare('UPDATE ui_tokens SET last_seen_at = ? WHERE last_seen_at <> ?').run(SIGNED_OUT_AT, SIGNED_OUT_AT);
}

// ---- cookies ----------------------------------------------------------------------------------------------------

/** The jv_ui cookie of a request, if any. */
export function requestToken(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Whether the request came over TLS (directly, or through a proxy that says so). */
export function overTls(req: IncomingMessage): boolean {
  if ((req.socket as TLSSocket).encrypted === true) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
  return first === 'https';
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(TOKEN_VALID_MS / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// ---- wrong passwords --------------------------------------------------------------------------------------------

/** Counts wrong passwords per address; five within a minute blocks that address for a minute. In memory only. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds until this address may try again, or 0. */
  retryAfter(address: string): number {
    const until = this.blockedUntil.get(address);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.blockedUntil.delete(address);
    return 0;
  }

  fail(address: string): void {
    const now = this.now();
    const recent = (this.failures.get(address) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    recent.push(now);
    if (recent.length >= LOGIN_FAILURES) {
      this.blockedUntil.set(address, now + LOGIN_BLOCK_MS);
      this.failures.delete(address);
    } else {
      this.failures.set(address, recent);
    }
    // Forget addresses with nothing recent, so the maps stay small.
    for (const [a, times] of this.failures) if (times.every((t) => now - t >= LOGIN_WINDOW_MS)) this.failures.delete(a);
  }

  succeed(address: string): void {
    this.failures.delete(address);
  }
}
