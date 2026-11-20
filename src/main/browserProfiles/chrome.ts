// Chrome's profiles on this Mac, and the cookies in them. Every profile is a
// folder under Chrome's own (`Default`, `Profile 1`, …), named in `Local State`
// as the person sees it. Its cookies are a SQLite database Chrome keeps open,
// so it is read from a copy, never in place: nothing here writes to Chrome.
// The values are encrypted with a key in the Keychain (cookies.ts); host names
// are not, so a profile's sites are read without asking the Keychain anything.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromeExpiry, chromeNow, chromeSameSite, decryptChromeValue, type BrowserCookie } from "./cookies";

/** Chrome's folder under a home. */
export const chromeBase = (home: string): string => join(home, "Library", "Application Support", "Google", "Chrome");

/** The folders Chrome makes for people's profiles; not its Guest or System ones. */
export const CHROME_PROFILE_DIR = /^(Default|Profile [1-9]\d{0,3})$/;

export interface ChromeProfile {
  /** Its folder's name: the id's second half (`chrome:Profile 1`). */
  dir: string;
  name: string;
  email?: string;
  /** Its cookie database. */
  cookies: string;
}

type InfoCache = Record<string, { name?: unknown; user_name?: unknown }>;

/** Chrome 155 keeps a profile's cookies at its top; older ones under `Network/`. */
function cookiesOf(profileDir: string): string | null {
  for (const p of [join(profileDir, "Cookies"), join(profileDir, "Network", "Cookies")]) if (existsSync(p)) return p;
  return null;
}

/** Every profile with a cookie database, in Chrome's order: `Default` first,
 *  then by number. A folder `Local State` doesn't name is still listed, under
 *  its folder's name. */
export function listChromeProfiles(home: string): ChromeProfile[] {
  const base = chromeBase(home);
  if (!existsSync(base)) return [];
  let info: InfoCache = {};
  try {
    const state = JSON.parse(readFileSync(join(base, "Local State"), "utf8")) as { profile?: { info_cache?: InfoCache } };
    info = state.profile?.info_cache ?? {};
  } catch {
    // No Local State, or none readable: the folders still say what is there.
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(base).filter((d) => CHROME_PROFILE_DIR.test(d));
  } catch {
    return [];
  }
  const order = (d: string) => (d === "Default" ? 0 : Number(d.slice("Profile ".length)));
  const out: ChromeProfile[] = [];
  for (const dir of dirs.sort((a, b) => order(a) - order(b))) {
    const cookies = cookiesOf(join(base, dir));
    if (!cookies) continue;
    const i = info[dir] ?? {};
    const name = typeof i.name === "string" && i.name.trim() ? i.name.trim() : dir;
    const email = typeof i.user_name === "string" && i.user_name.trim() ? i.user_name.trim() : undefined;
    out.push({ dir, name, ...(email ? { email } : null), cookies });
  }
  return out;
}

type Db = import("node:sqlite").DatabaseSync;

/**
 * Run `read` on a copy of Chrome's database, and delete the copy whatever
 * happens. The copy takes the journal or write-ahead log with it, so a write
 * Chrome is in the middle of either lands whole or not at all; the copy is
 * opened writable for that (SQLite settles a journal on opening), and it is
 * ours, so Chrome's own file is never touched.
 */
export async function onCopy<T>(db: string, read: (d: Db) => T): Promise<T> {
  // Loaded when first needed: a shell whose Node lacks it still starts, and
  // only this fails.
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "mafold-chrome-"));
  try {
    const copy = join(dir, "Cookies");
    await copyFile(db, copy);
    for (const side of ["-wal", "-journal"]) if (existsSync(db + side)) await copyFile(db + side, copy + side);
    const d = new DatabaseSync(copy);
    try {
      return read(d);
    } finally {
      d.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The database's version (`meta`): from 24 a value carries its host's hash. */
function dbVersion(d: Db): number {
  try {
    const row = d.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
    const v = Number(row?.value);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** How many live cookies each host has. Names only: nothing is decrypted. */
export function chromeHosts(db: string, now: number): Promise<{ host: string; cookies: number }[]> {
  return onCopy(db, (d) => {
    const q = d.prepare("SELECT host_key AS host, COUNT(*) AS n FROM cookies WHERE expires_utc = 0 OR expires_utc > ? GROUP BY host_key");
    return (q.all(chromeNow(now)) as { host: unknown; n: unknown }[])
      .filter((r) => typeof r.host === "string")
      .map((r) => ({ host: r.host as string, cookies: Number(r.n) }));
  });
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
}

/** Every live cookie of the profile, decrypted with `key`. One that doesn't
 *  decrypt (another key's, or a host hash that doesn't match) is counted in
 *  `skipped` and left out. */
export function readChromeCookies(db: string, key: Buffer, now: number): Promise<{ cookies: BrowserCookie[]; skipped: number }> {
  return onCopy(db, (d) => {
    const version = dbVersion(d);
    const q = d.prepare(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE expires_utc = 0 OR expires_utc > ?",
    );
    // `expires_utc` is past 2^53: as numbers it would not come back at all.
    q.setReadBigInts(true);
    const cookies: BrowserCookie[] = [];
    let skipped = 0;
    for (const r of q.all(chromeNow(now)) as unknown as CookieRow[]) {
      const value = r.value ? r.value : r.encrypted_value?.length ? decryptChromeValue(r.encrypted_value, key, r.host_key, version) : "";
      if (value === null) {
        skipped += 1;
        continue;
      }
      const expires = chromeExpiry(r.expires_utc);
      cookies.push({
        host: r.host_key,
        name: r.name,
        value,
        path: r.path || "/",
        secure: Number(r.is_secure) !== 0,
        httpOnly: Number(r.is_httponly) !== 0,
        sameSite: chromeSameSite(Number(r.samesite)),
        ...(expires !== undefined ? { expires } : null),
      });
    }
    return { cookies, skipped };
  });
}

/** Why the Keychain gave no password: the person said no, or there is none. */
export class KeychainRefused extends Error {}

/**
 * Chrome's "Chrome Safe Storage" password, from the Keychain. macOS asks the
 * person first, in its own dialog naming Mafold; a no (or no such item) is a
 * non-zero exit. The password never leaves this function but as its key.
 */
export function chromePassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
      // The dialog waits for the person; this only ends a call nobody answers.
      { timeout: 5 * 60_000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return reject(new KeychainRefused(typeof err.code === "number" ? `exit ${err.code}` : String(err.code ?? err.message)));
        const password = String(stdout).replace(/\r?\n$/, "");
        if (!password) return reject(new KeychainRefused("empty"));
        resolve(password);
      },
    );
  });
}
