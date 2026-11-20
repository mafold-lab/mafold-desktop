// Safari's cookies on this Mac. They sit in Safari's container, which macOS
// keeps from every other app: without Full Disk Access even listing the folder
// is refused (EPERM), so that is what a refusal means here, and the person is
// sent to grant it (`browsers.openFullDiskAccess`). The file is Apple's
// `binarycookies` format, read by `parseBinaryCookies`, which is pure.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserCookie } from "./cookies";

export const SAFARI_APP = "/Applications/Safari.app";

const container = (home: string): string => join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library");

/** Safari's own cookies (its default profile). */
export const safariCookies = (home: string): string => join(container(home), "Cookies", "Cookies.binarycookies");

/** Where Safari 17's other profiles might keep theirs: a data store per
 *  profile, named by a UUID. Not seen on a real Mac yet, so a profile is listed
 *  from here only when its file is really there. */
const dataStores = (home: string): string => join(container(home), "WebKit", "WebsiteDataStore");

export interface SafariProfile {
  /** `default`, or the data store's UUID: the id's second half. */
  key: string;
  name: string;
  cookies: string;
}

/** Full Disk Access is missing: macOS answers a read of Safari's container so. */
export const noAccess = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
};

/**
 * Safari's profiles. `blocked`: Mafold may not read Safari's container (no
 * Full Disk Access), so only the default profile is known, and nothing of it.
 * No Safari at all, no profiles.
 */
export async function listSafariProfiles(home: string, safariApp = SAFARI_APP): Promise<{ profiles: SafariProfile[]; blocked: boolean }> {
  if (!(await exists(safariApp))) return { profiles: [], blocked: false };
  const profiles: SafariProfile[] = [{ key: "default", name: "Safari", cookies: safariCookies(home) }];
  try {
    await readdir(join(container(home), "Cookies"));
  } catch (err) {
    if (noAccess(err)) return { profiles, blocked: true };
  }
  let stores: string[] = [];
  try {
    stores = await readdir(dataStores(home));
  } catch {
    // No data stores: Safari's own profile is all there is.
  }
  for (const uuid of stores.filter((s) => UUID.test(s)).sort()) {
    const cookies = join(dataStores(home), uuid, "Cookies", "Cookies.binarycookies");
    if (await exists(cookies)) profiles.push({ key: uuid, name: `Safari (${uuid.slice(0, 8)})`, cookies });
  }
  return { profiles, blocked: false };
}

export const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A profile's cookies. A file that isn't there (Safari never used) holds
 *  none; a refusal is thrown for the caller to name (`noAccess`). */
export async function readSafariCookies(file: string): Promise<BrowserCookie[]> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return [];
    throw err;
  }
  return parseBinaryCookies(buf);
}

/** Seconds between 1970-01-01 and 2001-01-01, Apple's epoch. */
const MAC_TO_UNIX = 978_307_200;

const SECURE = 1;
const HTTP_ONLY = 4;

/**
 * Apple's `Cookies.binarycookies`: `cook`, a big-endian page count and page
 * sizes, then the pages. A page is a 0x00000100 header, a little-endian cookie
 * count and offsets, and a footer; a cookie, little-endian: its size, flags,
 * the offsets (from its own start) of its domain, name, path and value, and
 * its expiry in Apple's seconds. A page or cookie that doesn't add up is
 * skipped, not trusted: the rest of the file still counts.
 */
export function parseBinaryCookies(buf: Buffer): BrowserCookie[] {
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== "cook") throw new Error("not a binarycookies file");
  const pages = buf.readUInt32BE(4);
  let at = 8 + pages * 4;
  if (pages > 100_000 || at > buf.length) throw new Error("binarycookies page table runs past the file");
  const out: BrowserCookie[] = [];
  for (let i = 0; i < pages; i++) {
    const size = buf.readUInt32BE(8 + i * 4);
    const end = at + size;
    if (end > buf.length) break;
    readPage(buf.subarray(at, end), out);
    at = end;
  }
  return out;
}

function readPage(page: Buffer, out: BrowserCookie[]): void {
  if (page.length < 8 || page.readUInt32BE(0) !== 0x00000100) return;
  const count = page.readUInt32LE(4);
  if (8 + count * 4 > page.length) return;
  for (let i = 0; i < count; i++) {
    const c = readCookie(page, page.readUInt32LE(8 + i * 4));
    if (c) out.push(c);
  }
}

function readCookie(page: Buffer, start: number): BrowserCookie | null {
  if (start + 56 > page.length) return null;
  const size = page.readUInt32LE(start);
  if (size < 56 || start + size > page.length) return null;
  const cookie = page.subarray(start, start + size);
  const flags = cookie.readUInt32LE(8);
  const str = (offset: number): string | null => {
    if (offset < 56 || offset >= cookie.length) return null;
    const nul = cookie.indexOf(0, offset);
    return cookie.toString("utf8", offset, nul < 0 ? cookie.length : nul);
  };
  const host = str(cookie.readUInt32LE(16));
  const name = str(cookie.readUInt32LE(20));
  const path = str(cookie.readUInt32LE(24));
  const value = str(cookie.readUInt32LE(28));
  if (!host || name === null || value === null) return null;
  const expiry = cookie.readDoubleLE(40);
  return {
    host,
    name,
    value,
    path: path || "/",
    secure: (flags & SECURE) !== 0,
    httpOnly: (flags & HTTP_ONLY) !== 0,
    // The file's SameSite isn't known well enough to trust: what Safari
    // didn't say, Chromium decides by its own default.
    sameSite: "unspecified",
    ...(Number.isFinite(expiry) && expiry > 0 ? { expires: Math.floor(expiry + MAC_TO_UNIX) } : null),
  };
}
