// browserProfiles/ without Electron or a browser: Chrome's encryption against
// values encrypted here the way Chrome does it, its dates and SameSite, a
// cookie on its way to `cookies.set`, Safari's file format from a file built
// here, sites by registrable domain, and Chrome's profiles read from a home
// made in a temp folder (its cookie database built with node:sqlite). That the
// real browsers' files read this way was checked on a real Mac by hand.

import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/log", () => ({ log: () => {} }));

import { chromeBase, chromeHosts, listChromeProfiles, readChromeCookies } from "../src/main/browserProfiles/chrome";
import {
  chromeExpiry,
  chromeKey,
  chromeNow,
  chromeSameSite,
  cookieUrl,
  decryptChromeValue,
  expired,
  groupSites,
  ofSites,
  registrableDomain,
  setDetails,
  type BrowserCookie,
} from "../src/main/browserProfiles/cookies";
import { listSafariProfiles, parseBinaryCookies, safariCookies } from "../src/main/browserProfiles/safari";
import { ProfileStore } from "../src/main/browserProfiles/store";
import { copiesOf, CopyStore, heldPlace, browserPlace, mergeCopies, nextRun, planSync, type HeldCookie } from "../src/main/browserProfiles/sync";

const PASSWORD = "c2VjcmV0LXNhZmUtc3RvcmFnZQ==";
const key = chromeKey(PASSWORD);

/** A value as Chrome on macOS writes it: `v10`, AES-128-CBC under the derived
 *  key with sixteen spaces for IV, and from version 24 the host's hash first. */
function chromeEncrypt(value: string, host: string, version = 24, k = key): Buffer {
  const c = createCipheriv("aes-128-cbc", k, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([version >= 24 ? createHash("sha256").update(host).digest() : Buffer.alloc(0), Buffer.from(value, "utf8")]);
  return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
}

describe("Chrome's encryption", () => {
  it("derives the key Chrome does (PBKDF2-SHA1, saltysalt, 1003, 16 bytes)", () => {
    expect(key.length).toBe(16);
    expect(chromeKey(PASSWORD).equals(key)).toBe(true);
    expect(chromeKey("other").equals(key)).toBe(false);
  });

  it("decrypts a value, checking and dropping the host's hash from version 24", () => {
    expect(decryptChromeValue(chromeEncrypt("sess=abc; ü", ".github.com"), key, ".github.com", 24)).toBe("sess=abc; ü");
    // A value long enough to span blocks, and an empty one.
    const long = "x".repeat(1000);
    expect(decryptChromeValue(chromeEncrypt(long, "a.com"), key, "a.com", 24)).toBe(long);
    expect(decryptChromeValue(chromeEncrypt("", "a.com"), key, "a.com", 24)).toBe("");
  });

  it("before version 24 there is no hash", () => {
    expect(decryptChromeValue(chromeEncrypt("v", "a.com", 23), key, "a.com", 23)).toBe("v");
  });

  it("refuses a value moved onto another host's row", () => {
    expect(decryptChromeValue(chromeEncrypt("v", ".github.com"), key, ".evil.com", 24)).toBeNull();
  });

  it("refuses another key's value, and anything that isn't v10", () => {
    expect(decryptChromeValue(chromeEncrypt("v", "a.com", 24, chromeKey("wrong")), key, "a.com", 24)).toBeNull();
    expect(decryptChromeValue(Buffer.from("v11abcdefabcdefabcdef"), key, "a.com", 24)).toBeNull();
    expect(decryptChromeValue(Buffer.from("v1"), key, "a.com", 24)).toBeNull();
  });
});

describe("Chrome's dates and SameSite", () => {
  it("turns microseconds since 1601 into unix seconds; 0 is a session cookie", () => {
    expect(chromeExpiry(0)).toBeUndefined();
    expect(chromeExpiry(0n)).toBeUndefined();
    expect(chromeExpiry(11_644_473_600_000_000n)).toBe(0);
    // 2026-11-17T00:00:00Z — past 2^53 microseconds, so a bigint.
    const unix = Date.UTC(2026, 10, 17) / 1000;
    const utc = BigInt(unix + 11_644_473_600) * 1_000_000n + 123_456n;
    expect(utc > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(chromeExpiry(utc)).toBe(unix);
    expect(chromeNow(unix)).toBe(utc - 123_456n);
  });

  it("knows what has expired", () => {
    expect(expired({ expires: 100 }, 100)).toBe(true);
    expect(expired({ expires: 101 }, 100)).toBe(false);
    expect(expired({}, 100)).toBe(false);
  });

  it("maps samesite", () => {
    expect(chromeSameSite(-1)).toBe("unspecified");
    expect(chromeSameSite(0)).toBe("no_restriction");
    expect(chromeSameSite(1)).toBe("lax");
    expect(chromeSameSite(2)).toBe("strict");
    expect(chromeSameSite(7)).toBe("unspecified");
  });
});

const cookie = (c: Partial<BrowserCookie>): BrowserCookie => ({
  host: "github.com",
  name: "n",
  value: "v",
  path: "/",
  secure: true,
  httpOnly: false,
  sameSite: "lax",
  ...c,
});

describe("into cookies.set", () => {
  it("keeps a host-only cookie host-only", () => {
    expect(setDetails(cookie({ expires: 2_000_000_000, httpOnly: true }))).toEqual({
      url: "https://github.com/",
      name: "n",
      value: "v",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: 2_000_000_000,
      sameSite: "lax",
    });
  });

  it("names the domain of a domain cookie, at its own path, over http when not secure", () => {
    const d = setDetails(cookie({ host: ".example.co.uk", path: "/app", secure: false }));
    expect(d.url).toBe("http://example.co.uk/app");
    expect(d.domain).toBe(".example.co.uk");
    expect(d.path).toBe("/app");
    expect("expirationDate" in d).toBe(false); // a session cookie
  });

  it("never names a domain for a __Host- cookie", () => {
    expect("domain" in setDetails(cookie({ host: ".github.com", name: "__Host-user_session_same_site" }))).toBe(false);
  });

  it("lowers SameSite=None without Secure to unspecified (Chromium refuses it)", () => {
    expect(setDetails(cookie({ sameSite: "no_restriction", secure: false })).sameSite).toBe("unspecified");
    expect(setDetails(cookie({ sameSite: "no_restriction", secure: true })).sameSite).toBe("no_restriction");
  });

  it("names a cookie's url for removing it the same way", () => {
    expect(cookieUrl(".github.com", "/", true)).toBe("https://github.com/");
    expect(cookieUrl("a.com", "x", false)).toBe("http://a.com/x");
  });
});

describe("sites", () => {
  it("are registrable domains", () => {
    expect(registrableDomain("mail.google.com")).toBe("google.com");
    expect(registrableDomain(".github.com")).toBe("github.com");
    expect(registrableDomain("github.com")).toBe("github.com");
    expect(registrableDomain(".www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("a.b.example.de")).toBe("example.de");
    // A two-letter TLD whose second level isn't a registry: the last two.
    expect(registrableDomain("x.notion.so")).toBe("notion.so");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("192.168.1.10")).toBe("192.168.1.10");
    expect(registrableDomain("Accounts.Google.COM")).toBe("google.com");
  });

  it("are grouped and sorted by cookies, most first", () => {
    const sites = groupSites([
      { host: ".github.com", cookies: 3 },
      { host: "github.com", cookies: 2 },
      { host: "mail.google.com", cookies: 4 },
      { host: ".google.com", cookies: 4 },
      { host: "a.com", cookies: 1 },
      { host: "b.com", cookies: 1 },
    ]);
    expect(sites).toEqual([
      { site: "google.com", cookies: 8 },
      { site: "github.com", cookies: 5 },
      { site: "a.com", cookies: 1 },
      { site: "b.com", cookies: 1 },
    ]);
  });

  it("an import of some sites takes only theirs", () => {
    const all = [cookie({ host: ".github.com" }), cookie({ host: "gist.github.com" }), cookie({ host: "google.com" })];
    expect(ofSites(all, new Set(["github.com"])).map((c) => c.host)).toEqual([".github.com", "gist.github.com"]);
    expect(ofSites(all)).toHaveLength(3);
  });
});

// ── Safari's file ───────────────────────────────────────────────────────────

const MAC_EPOCH = 978_307_200;

interface Raw {
  domain: string;
  name: string;
  path: string;
  value: string;
  flags: number;
  expiry: number; // unix
}

function cookieRecord(c: Raw): Buffer {
  const strings = [c.domain, c.name, c.path, c.value].map((s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.alloc(1)]));
  const head = Buffer.alloc(56);
  const size = 56 + strings.reduce((n, s) => n + s.length, 0);
  head.writeUInt32LE(size, 0);
  head.writeUInt32LE(0, 4);
  head.writeUInt32LE(c.flags, 8);
  head.writeUInt32LE(0, 12);
  let at = 56;
  strings.forEach((s, i) => {
    head.writeUInt32LE(at, 16 + i * 4);
    at += s.length;
  });
  head.writeDoubleLE(c.expiry - MAC_EPOCH, 40);
  head.writeDoubleLE(0, 48);
  return Buffer.concat([head, ...strings]);
}

function page(cookies: Raw[]): Buffer {
  const records = cookies.map(cookieRecord);
  const head = Buffer.alloc(8 + records.length * 4);
  head.writeUInt32BE(0x00000100, 0);
  head.writeUInt32LE(records.length, 4);
  let at = head.length + 4;
  records.forEach((r, i) => {
    head.writeUInt32LE(at, 8 + i * 4);
    at += r.length;
  });
  return Buffer.concat([head, Buffer.alloc(4), ...records]);
}

function binaryCookies(pages: Buffer[]): Buffer {
  const head = Buffer.alloc(8 + pages.length * 4);
  head.write("cook", 0, "latin1");
  head.writeUInt32BE(pages.length, 4);
  pages.forEach((p, i) => head.writeUInt32BE(p.length, 8 + i * 4));
  // The real file ends in a checksum and a plist; the parser reads past neither.
  return Buffer.concat([head, ...pages, Buffer.from([0, 0, 0, 0, 7, 23, 32, 5])]);
}

describe("Safari's binarycookies", () => {
  it("reads every cookie of every page", () => {
    const file = binaryCookies([
      page([
        { domain: ".github.com", name: "user_session", path: "/", value: "abc", flags: 5, expiry: 2_000_000_000 },
        { domain: "www.apple.com", name: "a", path: "/shop", value: "1", flags: 0, expiry: 1_900_000_000 },
      ]),
      page([{ domain: ".bbc.co.uk", name: "ckns", path: "/", value: "π", flags: 4, expiry: 1_800_000_000 }]),
    ]);
    expect(parseBinaryCookies(file)).toEqual([
      { host: ".github.com", name: "user_session", value: "abc", path: "/", secure: true, httpOnly: true, sameSite: "unspecified", expires: 2_000_000_000 },
      { host: "www.apple.com", name: "a", value: "1", path: "/shop", secure: false, httpOnly: false, sameSite: "unspecified", expires: 1_900_000_000 },
      { host: ".bbc.co.uk", name: "ckns", value: "π", path: "/", secure: false, httpOnly: true, sameSite: "unspecified", expires: 1_800_000_000 },
    ]);
  });

  it("refuses what isn't one, and skips a page that doesn't add up", () => {
    expect(() => parseBinaryCookies(Buffer.from("nope1234"))).toThrow();
    const good = page([{ domain: "a.com", name: "n", path: "/", value: "v", flags: 0, expiry: 2_000_000_000 }]);
    const bad = Buffer.from(good);
    bad.writeUInt32BE(0xdeadbeef, 0);
    expect(parseBinaryCookies(binaryCookies([bad, good])).map((c) => c.host)).toEqual(["a.com"]);
    // A page table longer than the file: nothing past it is read.
    const short = binaryCookies([good]).subarray(0, 20);
    expect(parseBinaryCookies(short)).toEqual([]);
  });
});

// ── on disk ─────────────────────────────────────────────────────────────────

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mafold-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 10, 17) / 1000;

function chromeDb(file: string, rows: { host: string; name: string; value?: string; enc?: Buffer; expires: bigint; samesite?: number }[], version = 24): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT);
    CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL, samesite INTEGER NOT NULL DEFAULT -1);`);
  d.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  const ins = d.prepare("INSERT INTO cookies (creation_utc, host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite) VALUES (0, ?, ?, ?, ?, '/', ?, 1, 1, ?)");
  for (const r of rows) ins.run(r.host, r.name, r.value ?? "", r.enc ?? Buffer.alloc(0), r.expires, r.samesite ?? -1);
  d.close();
}

describe("Chrome's profiles", () => {
  it("lists the profiles with a cookie database, named as Local State names them", () => {
    const base = chromeBase(home);
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1", user_name: "" }, "Profile 2": { name: "Work", user_name: "me@work.example" } } } }),
    );
    chromeDb(join(base, "Profile 2", "Cookies"), []);
    chromeDb(join(base, "Default", "Network", "Cookies"), []); // where Chrome kept it before
    chromeDb(join(base, "Profile 10", "Cookies"), []); // not in Local State
    mkdirSync(join(base, "Profile 3")); // no cookies: nothing to bring in
    chromeDb(join(base, "Guest Profile", "Cookies"), []);
    chromeDb(join(base, "System Profile", "Cookies"), []);
    expect(listChromeProfiles(home)).toEqual([
      { dir: "Default", name: "Person 1", cookies: join(base, "Default", "Network", "Cookies") },
      { dir: "Profile 2", name: "Work", email: "me@work.example", cookies: join(base, "Profile 2", "Cookies") },
      { dir: "Profile 10", name: "Profile 10", cookies: join(base, "Profile 10", "Cookies") },
    ]);
  });

  it("has none without Chrome", () => {
    expect(listChromeProfiles(home)).toEqual([]);
  });

  it("reads hosts without the key, and cookies with it, from a copy", async () => {
    const db = join(chromeBase(home), "Default", "Cookies");
    const later = chromeNow(NOW + 86_400) + 5n;
    chromeDb(db, [
      { host: ".github.com", name: "user_session", enc: chromeEncrypt("s3cret", ".github.com"), expires: later, samesite: 1 },
      { host: "github.com", name: "plain", value: "as-is", expires: 0n },
      { host: ".github.com", name: "stolen", enc: chromeEncrypt("x", ".evil.com"), expires: later },
      { host: "mail.google.com", name: "old", enc: chromeEncrypt("x", "mail.google.com"), expires: chromeNow(NOW - 1) },
    ]);
    expect(await chromeHosts(db, NOW)).toEqual(
      expect.arrayContaining([
        { host: ".github.com", cookies: 2 },
        { host: "github.com", cookies: 1 },
      ]),
    );
    expect(groupSites(await chromeHosts(db, NOW))).toEqual([{ site: "github.com", cookies: 3 }]);

    const { cookies, skipped } = await readChromeCookies(db, key, NOW);
    expect(skipped).toBe(1);
    expect(cookies).toEqual([
      { host: ".github.com", name: "user_session", value: "s3cret", path: "/", secure: true, httpOnly: true, sameSite: "lax", expires: NOW + 86_400 },
      { host: "github.com", name: "plain", value: "as-is", path: "/", secure: true, httpOnly: true, sameSite: "unspecified" },
    ]);
    // The copy is gone; Chrome's file is as it was.
    const d = new DatabaseSync(db, { readOnly: true });
    expect((d.prepare("SELECT COUNT(*) AS n FROM cookies").get() as { n: number }).n).toBe(4);
    d.close();
  });
});

describe("Safari's profiles", () => {
  it("has none without Safari", async () => {
    expect(await listSafariProfiles(home, join(home, "Safari.app"))).toEqual({ profiles: [], blocked: false });
  });

  it("lists Safari's own, and a data store's only when its cookies are there", async () => {
    const app = join(home, "Safari.app");
    mkdirSync(app);
    const stores = join(home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "WebKit", "WebsiteDataStore");
    const uuid = "0A1B2C3D-0000-4000-8000-000000000001";
    mkdirSync(join(stores, uuid, "Cookies"), { recursive: true });
    writeFileSync(join(stores, uuid, "Cookies", "Cookies.binarycookies"), binaryCookies([]));
    mkdirSync(join(stores, "1A1B2C3D-0000-4000-8000-000000000002"), { recursive: true });
    mkdirSync(join(stores, "not-a-uuid", "Cookies"), { recursive: true });
    const { profiles, blocked } = await listSafariProfiles(home, app);
    expect(blocked).toBe(false);
    expect(profiles).toEqual([
      { key: "default", name: "Safari", cookies: safariCookies(home) },
      { key: uuid, name: "Safari (0A1B2C3D)", cookies: join(stores, uuid, "Cookies", "Cookies.binarycookies") },
    ]);
  });
});

describe("the store", () => {
  it("remembers what was brought in, across a restart", () => {
    const file = join(home, "data", "browser-profiles.json");
    const a = new ProfileStore(file);
    a.set("chrome:Default", { imported_at: 1, imported_sites: 12 });
    a.set("safari:default", { imported_at: 2, imported_sites: 3 });
    a.delete("safari:default");
    const b = new ProfileStore(file);
    expect(b.ids()).toEqual(["chrome:Default"]);
    expect(b.get("chrome:Default")).toEqual({ imported_at: 1, imported_sites: 12 });
  });

  it("keeps the chosen sites and the last sync", () => {
    const file = join(home, "data", "browser-profiles.json");
    new ProfileStore(file).set("chrome:Profile 1", { imported_at: 1, imported_sites: 2, sites: ["github.com", "x.com"], synced_at: 9 });
    expect(new ProfileStore(file).get("chrome:Profile 1")).toEqual({ imported_at: 1, imported_sites: 2, sites: ["github.com", "x.com"], synced_at: 9 });
  });

  it("starts empty from nothing, or from nonsense", () => {
    writeFileSync(join(home, "x.json"), "[1,2]");
    expect(new ProfileStore(join(home, "x.json")).ids()).toEqual([]);
    expect(new ProfileStore(join(home, "none.json")).ids()).toEqual([]);
  });
});

describe("keeping a profile in step", () => {
  const c = (host: string, name: string, value: string, path = "/"): BrowserCookie => ({
    host, name, value, path, secure: true, httpOnly: true, sameSite: "lax",
  });
  /** As Electron's `cookies.get` gives it back after `cookies.set`. */
  const held = (b: BrowserCookie, value = b.value): HeldCookie => ({
    domain: b.host, hostOnly: !b.host.startsWith("."), name: b.name, path: b.path, value, secure: b.secure,
  });

  it("names a cookie's place the same from the browser and from Electron", () => {
    for (const b of [c("github.com", "user_session", "a"), c(".github.com", "_gh_sess", "b"), c("x.com", "auth", "c", "/i")]) {
      expect(heldPlace(held(b))).toBe(browserPlace(b));
    }
    expect(browserPlace(c("github.com", "a", "1"))).not.toBe(browserPlace(c(".github.com", "a", "1")));
  });

  it("copies a site signed in to since, and leaves the rest alone", () => {
    const gh = c("github.com", "user_session", "s1");
    const last = copiesOf([gh]);
    const yt = c(".youtube.com", "LOGIN_INFO", "y1");
    const plan = planSync([gh, yt], [held(gh)], last);
    expect(plan.set).toEqual([yt]);
    expect(plan.remove).toEqual([]);
    expect(plan.copies).toEqual(copiesOf([gh, yt]));
  });

  it("copies a login the browser changed, over Mafold's", () => {
    const old = c("github.com", "user_session", "s1");
    const now = { ...old, value: "s2" };
    expect(planSync([now], [held(old, "mafold-refreshed")], copiesOf([old])).set).toEqual([now]);
  });

  it("never puts an unchanged browser value back over one the site refreshed here", () => {
    const gh = c("github.com", "user_session", "s1");
    const plan = planSync([gh], [held(gh, "refreshed-here")], copiesOf([gh]));
    expect(plan.set).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("signs out here what was signed out of there, unless the login moved on here", () => {
    const gh = c("github.com", "user_session", "s1");
    const x = c(".x.com", "auth_token", "t1");
    const last = copiesOf([gh, x]);
    const plan = planSync([], [held(gh), held(x, "t2")], last);
    expect(plan.remove).toEqual([held(gh)]);
    expect(plan.copies).toEqual({});
  });

  it("leaves alone what Mafold has that was never copied", () => {
    const own = c("notion.so", "token_v2", "n");
    expect(planSync([], [held(own)], {}).remove).toEqual([]);
  });

  it("copies everything the first time, for a profile brought in before syncing", () => {
    const gh = c("github.com", "user_session", "s1");
    expect(planSync([gh], [held(gh)], {}).set).toEqual([gh]);
  });

  it("an import of some sites replaces only theirs; of the whole profile, all", () => {
    const gh = c("github.com", "a", "1");
    const x = c("x.com", "b", "2");
    const last = copiesOf([gh, x]);
    const fresh = copiesOf([{ ...gh, value: "3" }]);
    expect(mergeCopies(last, fresh, new Set(["github.com"]))).toEqual({ ...copiesOf([x]), ...fresh });
    expect(mergeCopies(last, fresh)).toEqual(fresh);
  });

  it("keeps fingerprints, never a value", () => {
    const store = new CopyStore(join(home, "copies"));
    expect(store.get("chrome:Profile 1")).toBeNull();
    const copies = copiesOf([c("github.com", "user_session", "very-secret-session")]);
    store.set("chrome:Profile 1", copies);
    expect(store.get("chrome:Profile 1")).toEqual(copies);
    expect(JSON.stringify(copies)).not.toContain("very-secret-session");
    expect(JSON.stringify(copies)).not.toContain("user_session");
    store.delete("chrome:Profile 1");
    expect(store.get("chrome:Profile 1")).toBeNull();
  });

  it("waits for the browser's write to settle, and runs no more than once in a while", () => {
    expect(nextRun(100_000, undefined)).toBe(103_000);
    expect(nextRun(100_000, 95_000)).toBe(115_000);
    expect(nextRun(100_000, 50_000)).toBe(103_000);
  });
});
