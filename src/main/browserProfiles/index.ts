// The person's Chrome and Safari logins, brought into Mafold's browser (cap
// `browser-profiles`, macOS; Settings ▸ Connections ▸ Browsers). Each profile
// gets a session of its own (`profilePartition`), guarded as the sites' own is
// (sites.ts `guardProfile`); a site tab in it is signed in where the profile
// was. Bringing them in copies the cookies as they are now, on this computer
// only: nothing is sent anywhere, the Keychain's key stays in memory, and the
// browsers' own files are only ever read, from a copy.
//
// What the page passes is checked in bridge.ts (validate.ts); this is the
// work. One import of a profile at a time, and a second one asked meanwhile
// says `busy` rather than racing it.

import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { app, session as electronSession } from "electron";

import { log } from "../log";
import type { Shell } from "../shell";
import { hasProfileSession } from "../siteSessions";
import { forgetProfile, guardProfile } from "../sites";
import {
  profilePartition,
  type BrowserError,
  type BrowserImportResult,
  type BrowserProfile,
  type BrowserSitesResult,
} from "../../shared/desktopHost.generated";
import { chromeHosts, chromePassword, KeychainRefused, listChromeProfiles, readChromeCookies, type ChromeProfile } from "./chrome";
import { chromeKey, cookieUrl, expired, groupSites, ofSites, registrableDomain, setDetails, type BrowserCookie } from "./cookies";
import { listSafariProfiles, noAccess, readSafariCookies, type SafariProfile } from "./safari";
import { ProfileStore } from "./store";

/** System Settings ▸ Privacy & Security ▸ Full Disk Access. */
export const FULL_DISK_ACCESS = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

type Found = { browser: "chrome"; profile: ChromeProfile } | { browser: "safari"; profile: SafariProfile; blocked: boolean };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** This computer's name as the network knows it ("MacBook-Pro-4"), for the
 *  connection's label: macOS adds `.local`, which says nothing to a person. */
const machineName = (): string => hostname().replace(/\.local\.?$/i, "") || "Mac";

export class BrowserProfiles {
  private readonly store: ProfileStore;
  private readonly importing = new Set<string>();
  /** Chrome's cookie key, once the Keychain gave it: for as long as the app
   *  runs, never written anywhere. A refusal isn't kept: the next import asks
   *  again. */
  private key: Promise<Buffer> | null = null;

  constructor(
    private readonly shell: Shell,
    private readonly home = homedir(),
  ) {
    this.store = new ProfileStore(join(app.getPath("userData"), "browser-profiles.json"));
    // Tabs come back with the page: every profile brought in before has its
    // guards before the page can ask for one.
    for (const id of this.store.ids()) guardProfile(shell, id);
  }

  /** `partition` is a profile the person brought in, and its session is guarded. */
  imported(partition: string): boolean {
    return hasProfileSession(partition) && this.store.ids().some((id) => profilePartition(id) === partition);
  }

  /** Every profile on this computer, with what was brought in of it. */
  async list(): Promise<BrowserProfile[]> {
    const now = nowSeconds();
    const machine = machineName();
    const out: BrowserProfile[] = [];
    for (const p of listChromeProfiles(this.home)) {
      const sites = await chromeHosts(p.cookies, now).then(
        (hosts) => groupSites(hosts).length,
        (err: unknown) => {
          log("chrome profile not read:", p.dir, String(err));
          return null;
        },
      );
      out.push(this.withImport({ id: `chrome:${p.dir}`, browser: "chrome", name: p.name, ...(p.email ? { email: p.email } : null), machine, sites }));
    }
    const safari = await listSafariProfiles(this.home);
    for (const p of safari.profiles) {
      const sites = safari.blocked
        ? null
        : await readSafariCookies(p.cookies).then(
            (cookies) => groupSites(cookies.filter((c) => !expired(c, now)).map((c) => ({ host: c.host, cookies: 1 }))).length,
            (err: unknown) => {
              if (!noAccess(err)) log("safari profile not read:", p.key, String(err));
              return null;
            },
          );
      out.push(this.withImport({ id: `safari:${p.key}`, browser: "safari", name: p.name, machine, sites }));
    }
    return out;
  }

  private withImport(p: BrowserProfile): BrowserProfile {
    const i = this.store.get(p.id);
    return i ? { ...p, imported_at: i.imported_at, imported_sites: i.imported_sites } : p;
  }

  /** The sites a profile holds logins for, most cookies first. Chrome's host
   *  names aren't encrypted: this never asks the Keychain. */
  async sites(id: string): Promise<BrowserSitesResult> {
    try {
      const found = await this.find(id);
      if (!found) return { ok: false, error: "gone" };
      const now = nowSeconds();
      if (found.browser === "chrome") return { ok: true, sites: groupSites(await chromeHosts(found.profile.cookies, now)) };
      if (found.blocked) return { ok: false, error: "full-disk-access" };
      const cookies = (await readSafariCookies(found.profile.cookies)).filter((c) => !expired(c, now));
      return { ok: true, sites: groupSites(cookies.map((c) => ({ host: c.host, cookies: 1 }))) };
    } catch (err) {
      return failure(err, "sites");
    }
  }

  /** Bring a profile's logins in: every site, or only `sites`. Again is a
   *  re-import: what the session held of those sites goes first, so a login
   *  signed out of in the browser since is signed out here too. */
  async import(id: string, sites?: string[]): Promise<BrowserImportResult> {
    if (this.importing.has(id)) return { ok: false, error: "busy" };
    this.importing.add(id);
    try {
      return await this.bringIn(id, sites);
    } catch (err) {
      return failure(err, "import");
    } finally {
      this.importing.delete(id);
    }
  }

  private async bringIn(id: string, only?: string[]): Promise<BrowserImportResult> {
    const found = await this.find(id);
    if (!found) return { ok: false, error: "gone" };
    const now = nowSeconds();
    const want = only ? new Set(only.map((s) => s.toLowerCase())) : undefined;

    let read: BrowserCookie[];
    let undecrypted = 0;
    if (found.browser === "chrome") {
      const key = await this.chromeKey();
      ({ cookies: read, skipped: undecrypted } = await readChromeCookies(found.profile.cookies, key, now));
    } else {
      if (found.blocked) return { ok: false, error: "full-disk-access" };
      read = await readSafariCookies(found.profile.cookies);
    }
    const cookies = ofSites(read.filter((c) => !expired(c, now)), want);

    // Guarded before it holds anything, and before any tab may show it.
    guardProfile(this.shell, id);
    const ses = electronSession.fromPartition(profilePartition(id));
    if (!want) await ses.clearStorageData({ storages: ["cookies"] });
    else {
      for (const c of await ses.cookies.get({})) {
        const host = c.domain ?? "";
        if (!want.has(registrableDomain(host))) continue;
        await ses.cookies.remove(cookieUrl(host, c.path ?? "/", c.secure === true), c.name).catch(() => {});
      }
    }

    // One cookie Chromium won't take (a name it finds invalid, a domain that
    // isn't the URL's) doesn't cost the rest: it is counted, and left.
    let set = 0;
    let refused = 0;
    const came = new Set<string>();
    for (const c of cookies) {
      try {
        await ses.cookies.set(setDetails(c));
        set += 1;
        came.add(registrableDomain(c.host));
      } catch {
        refused += 1;
      }
    }
    await ses.cookies.flushStore();

    // What the session holds now, all imports of it together: a re-import of
    // a few sites leaves the others it had.
    const held = groupSites((await ses.cookies.get({})).map((c) => ({ host: c.domain ?? "", cookies: 1 }))).length;
    const at = nowSeconds();
    this.store.set(id, { imported_at: at, imported_sites: held });
    log(`browser profile ${id}: ${set} cookies of ${came.size} sites in, ${refused} refused, ${undecrypted} not decrypted`);
    return { ok: true, sites: came.size, cookies: set, at };
  }

  /** Forget a profile: what its session holds, what its sites were allowed,
   *  and that it was brought in, so no tab may show it any more. Not while
   *  it is being brought in: that would bring it back. */
  async forget(id: string): Promise<boolean> {
    if (this.importing.has(id)) return false;
    await forgetProfile(id);
    this.store.delete(id);
    log(`browser profile ${id} forgotten`);
    return true;
  }

  openFullDiskAccess(): void {
    this.shell.openSystemSettings(FULL_DISK_ACCESS);
  }

  private chromeKey(): Promise<Buffer> {
    const k = (this.key ??= chromePassword().then(chromeKey));
    k.catch(() => {
      if (this.key === k) this.key = null;
    });
    return k;
  }

  private async find(id: string): Promise<Found | null> {
    const [browser, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
    if (browser === "chrome") {
      const profile = listChromeProfiles(this.home).find((p) => p.dir === rest);
      return profile ? { browser, profile } : null;
    }
    if (browser === "safari") {
      const { profiles, blocked } = await listSafariProfiles(this.home);
      const profile = profiles.find((p) => p.key === rest);
      return profile ? { browser, profile, blocked } : null;
    }
    return null;
  }
}

/** An error as the page gets it. Never a cookie, never the key: `detail` is
 *  the error's own words, for the log the page may show. */
function failure(err: unknown, what: string): { ok: false; error: BrowserError; detail?: string } {
  if (err instanceof KeychainRefused) {
    log(`browser profiles ${what}: keychain said no (${err.message})`);
    return { ok: false, error: "keychain" };
  }
  if (noAccess(err)) return { ok: false, error: "full-disk-access" };
  log(`browser profiles ${what} failed:`, String(err));
  return { ok: false, error: "failed", detail: err instanceof Error ? err.message : String(err) };
}
