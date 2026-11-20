// A cookie from the person's own browser, on its way into one of Mafold's
// sessions (cap `browser-profiles`). Chrome and Safari keep cookies each their
// own way (chrome.ts, safari.ts); both come down to `BrowserCookie`, and from
// there to what Electron's `cookies.set` takes. Pure, so test/browserProfiles
// covers every rule here without Electron or a browser.

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import type { CookiesSetDetails } from "electron";

import type { BrowserSite } from "../../shared/desktopHost.generated";

export type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";

/** One cookie, as either browser had it. `host` is the browser's own: a
 *  leading dot is a cookie for the domain and everything under it. */
export interface BrowserCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Unix seconds; absent = a session cookie. */
  expires?: number;
}

// ── Chrome's encryption (macOS) ─────────────────────────────────────────────

/** Chrome derives its cookie key from the Keychain's "Chrome Safe Storage"
 *  password, always the same way (Chromium os_crypt_mac). */
export const chromeKey = (password: string): Buffer => pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");

/** Chrome's IV on macOS: sixteen spaces. */
const CHROME_IV = Buffer.alloc(16, 0x20);

/**
 * An `encrypted_value` back to the cookie's value, or null when it isn't one
 * this key opens. `v10` + AES-128-CBC; from database version 24 Chrome puts
 * SHA256(host_key) before the value, so a value copied onto another host's row
 * doesn't decrypt as that host's — a prefix that doesn't match is refused, not
 * trimmed.
 */
export function decryptChromeValue(encrypted: Uint8Array, key: Buffer, hostKey: string, dbVersion: number): string | null {
  const enc = Buffer.from(encrypted);
  if (enc.length < 3 || enc.subarray(0, 3).toString("latin1") !== "v10") return null;
  let plain: Buffer;
  try {
    const d = createDecipheriv("aes-128-cbc", key, CHROME_IV);
    plain = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
  } catch {
    return null; // wrong key, or not padded as AES pads: not this cookie's value
  }
  if (dbVersion >= 24) {
    if (plain.length < 32) return null;
    const hash = createHash("sha256").update(hostKey).digest();
    if (!plain.subarray(0, 32).equals(hash)) return null;
    plain = plain.subarray(32);
  }
  return plain.toString("utf8");
}

/** Seconds between 1601-01-01 (Windows' epoch, Chrome's on every system) and 1970-01-01. */
const WINDOWS_TO_UNIX = 11_644_473_600;

/** Chrome's `expires_utc` (microseconds since 1601; 0 = a session cookie) as
 *  unix seconds. It is past 2^53 by now, so it comes from SQLite as a bigint. */
export function chromeExpiry(expiresUtc: bigint | number): number | undefined {
  const micros = typeof expiresUtc === "bigint" ? expiresUtc : BigInt(Math.trunc(expiresUtc));
  if (micros <= 0n) return undefined;
  return Number(micros / 1_000_000n) - WINDOWS_TO_UNIX;
}

/** Now, as Chrome writes `expires_utc`: for asking SQLite for the live ones. */
export const chromeNow = (unixSeconds: number): bigint => BigInt(Math.floor(unixSeconds) + WINDOWS_TO_UNIX) * 1_000_000n;

/** Chrome's `samesite` column. */
export function chromeSameSite(n: number): SameSite {
  if (n === 0) return "no_restriction";
  if (n === 1) return "lax";
  if (n === 2) return "strict";
  return "unspecified";
}

/** Gone by `now` (unix seconds). A session cookie never is. */
export const expired = (c: Pick<BrowserCookie, "expires">, now: number): boolean => c.expires !== undefined && c.expires <= now;

// ── into Electron ───────────────────────────────────────────────────────────

/** The URL a cookie belongs to, as Electron names one: where a browser would
 *  send it. Both setting and removing a cookie go by it. */
export const cookieUrl = (host: string, path: string, secure: boolean): string =>
  `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${path.startsWith("/") ? path : `/${path}`}`;

/**
 * What `cookies.set` takes for `c`. A host-only cookie names no domain (naming
 * one would make it a domain cookie); a `__Host-` one may never name it.
 * Chromium refuses SameSite=None without Secure, where Chrome had already let
 * the site lower it: unspecified is what Chrome treats it as then.
 */
export function setDetails(c: BrowserCookie): CookiesSetDetails {
  const path = c.path || "/";
  const domainCookie = c.host.startsWith(".") && !c.name.startsWith("__Host-");
  return {
    url: cookieUrl(c.host, path, c.secure),
    name: c.name,
    value: c.value,
    ...(domainCookie ? { domain: c.host } : null),
    path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.expires !== undefined ? { expirationDate: c.expires } : null),
    sameSite: c.sameSite === "no_restriction" && !c.secure ? "unspecified" : c.sameSite,
  };
}

// ── sites ───────────────────────────────────────────────────────────────────

/** Second-level labels under a two-letter country code that are registries of
 *  their own (`bbc.co.uk`, `example.com.au`). Not the public suffix list: close
 *  enough to name sites in a list, and nothing is decided by it but grouping. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** The site a cookie's host is part of: `mail.google.com` → `google.com`,
 *  `.www.bbc.co.uk` → `bbc.co.uk`. Addresses are their own site. */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[")) return h;
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  return labels.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join(".");
}

/** Cookie counts by host, as sites: most cookies first (then by name, so the
 *  list doesn't reshuffle between two reads of the same profile). */
export function groupSites(hosts: Iterable<{ host: string; cookies: number }>): BrowserSite[] {
  const by = new Map<string, number>();
  for (const { host, cookies } of hosts) {
    const site = registrableDomain(host);
    if (site) by.set(site, (by.get(site) ?? 0) + cookies);
  }
  return [...by].map(([site, cookies]) => ({ site, cookies })).sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

/** Only the cookies of `sites` (all of them without a list). */
export const ofSites = <T extends { host: string }>(cookies: T[], sites?: ReadonlySet<string>): T[] =>
  sites ? cookies.filter((c) => sites.has(registrableDomain(c.host))) : cookies;
