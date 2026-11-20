// The person's Chrome and Safari logins, brought into Mafold's browser (cap
// `browser-profiles`, macOS; Settings ▸ Connections ▸ Browsers). Each profile
// gets a session of its own (`profilePartition`), guarded as the sites' own is
// (sites.ts `guardProfile`); a site tab in it is signed in where the profile
// was. Bringing them in copies the cookies as they are then, on this computer
// only: nothing is sent anywhere, and the browsers' own files are only ever
// read, from a copy.
//
// After that a profile stays in step with its browser by itself (ops 11-18
// "Build it, always on"): its cookie file is watched, and what changed there
// comes over (sync.ts has the rule) a few seconds after the browser writes it,
// at launch, and every ten minutes besides. One way only: Mafold never writes
// to the browser. A sync never asks the person anything: Chrome's key is the
// one the Keychain gave on an import, kept sealed with the app's own
// safeStorage key (the one that already seals the sessions' cookies), so a
// restart doesn't ask the Keychain again; without safeStorage it is kept in
// memory only, and syncing a Chrome profile waits for the next import.
//
// What the page passes is checked in bridge.ts (validate.ts); this is the
// work. One import of a profile at a time, and a second one asked meanwhile
// says `busy` rather than racing it; an import waits for a sync under way.

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { app, safeStorage, session as electronSession } from "electron";

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
import { ProfileStore, type Imported } from "./store";
import { copiesOf, CopyStore, mergeCopies, nextRun, planSync } from "./sync";

/** System Settings ▸ Privacy & Security ▸ Full Disk Access. */
export const FULL_DISK_ACCESS = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

type Found = { browser: "chrome"; profile: ChromeProfile } | { browser: "safari"; profile: SafariProfile; blocked: boolean };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** How long after launch the first sync runs: the window comes first. */
const FIRST_SYNC_MS = 10_000;
/** Every profile is synced this often too, in case a write wasn't seen. */
const SWEEP_MS = 10 * 60_000;

/** This computer's name as the network knows it ("MacBook-Pro-4"), for the
 *  connection's label: macOS adds `.local`, which says nothing to a person. */
const machineName = (): string => hostname().replace(/\.local\.?$/i, "") || "Mac";

export class BrowserProfiles {
  private readonly store: ProfileStore;
  private readonly copies: CopyStore;
  /** Chrome's key, sealed with safeStorage. */
  private readonly keyFile: string;
  private readonly importing = new Set<string>();
  /** Syncs under way, by profile: an import or a forget waits for its own. */
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastStart = new Map<string, number>();
  /** Chrome's cookie key, once the Keychain (or the sealed copy) gave it. A
   *  refusal isn't kept: the next import asks again. */
  private key: Promise<Buffer> | null = null;

  constructor(
    private readonly shell: Shell,
    private readonly home = homedir(),
  ) {
    const data = app.getPath("userData");
    this.store = new ProfileStore(join(data, "browser-profiles.json"));
    this.copies = new CopyStore(join(data, "browser-profiles", "copies"));
    this.keyFile = join(data, "browser-profiles", "chrome-key");
    // Tabs come back with the page: every profile brought in before has its
    // guards before the page can ask for one.
    for (const id of this.store.ids()) guardProfile(shell, id);
    setTimeout(() => {
      for (const id of this.store.ids()) this.follow(id);
      setInterval(() => {
        for (const id of this.store.ids()) this.schedule(id);
      }, SWEEP_MS);
    }, FIRST_SYNC_MS);
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
    return i ? { ...p, imported_at: i.imported_at, imported_sites: i.imported_sites, ...(i.synced_at ? { synced_at: i.synced_at } : null) } : p;
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
      await this.syncing.get(id);
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
      const kept = this.key !== null || this.sealedKey() !== null;
      ({ cookies: read, skipped: undecrypted } = await readChromeCookies(found.profile.cookies, await this.chromeKey(), now));
      if (kept && !read.length && undecrypted) {
        // Nothing opened with the kept key: Chrome's was made anew since.
        // Ask the Keychain for it once more.
        this.dropKey();
        ({ cookies: read, skipped: undecrypted } = await readChromeCookies(found.profile.cookies, await this.chromeKey(), now));
      }
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
    // Some sites of a profile brought in whole leaves it whole; of one
    // brought in for some, adds to them.
    const before = this.store.get(id);
    const sites = !want ? undefined : before && !before.sites ? undefined : [...new Set([...(before?.sites ?? []), ...want])].sort();
    this.store.set(id, { imported_at: at, imported_sites: held, ...(sites ? { sites } : null), synced_at: at });
    this.copies.set(id, mergeCopies(this.copies.get(id) ?? {}, copiesOf(cookies), want));
    this.lastStart.set(id, Date.now());
    this.follow(id, false);
    log(`browser profile ${id}: ${set} cookies of ${came.size} sites in, ${refused} refused, ${undecrypted} not decrypted`);
    return { ok: true, sites: came.size, cookies: set, at };
  }

  // ── keeping in step ───────────────────────────────────────────────────────

  /** Watch a profile's cookie file, and sync it now (`now`) or when it next
   *  changes. Its folder is watched rather than the file: Chrome and Safari
   *  replace the file, and a watch on it would end there. */
  private follow(id: string, now = true): void {
    if (now) this.schedule(id);
    if (this.watchers.has(id)) return;
    void this.find(id).then(
      (found) => {
        if (!found || this.watchers.has(id) || !this.store.get(id)) return;
        if (found.browser === "safari" && found.blocked) return;
        const file = found.profile.cookies;
        const name = basename(file);
        try {
          const w = watch(dirname(file), (_event, changed) => {
            if (!changed || String(changed).startsWith(name)) this.schedule(id);
          });
          w.on("error", (err) => {
            log(`browser profile ${id}: watch ended:`, String(err));
            this.unfollow(id);
          });
          this.watchers.set(id, w);
        } catch (err) {
          log(`browser profile ${id}: not watched:`, String(err));
        }
      },
      (err: unknown) => log(`browser profile ${id}: not found to watch:`, String(err)),
    );
  }

  private unfollow(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  /** A sync of `id` soon: one waiting already covers this ask too. */
  private schedule(id: string): void {
    if (this.timers.has(id)) return;
    const wait = nextRun(Date.now(), this.lastStart.get(id)) - Date.now();
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        if (this.importing.has(id) || this.syncing.has(id)) return this.schedule(id);
        const run = this.sync(id).finally(() => this.syncing.delete(id));
        this.syncing.set(id, run);
      }, wait),
    );
  }

  private async sync(id: string): Promise<void> {
    const imported = this.store.get(id);
    if (!imported) return;
    this.lastStart.set(id, Date.now());
    try {
      const found = await this.find(id);
      if (!found) return;
      const now = nowSeconds();
      let read: BrowserCookie[];
      if (found.browser === "chrome") {
        const key = await this.keptKey();
        if (!key) return; // never asks: the next import will
        const r = await readChromeCookies(found.profile.cookies, key, now);
        if (!r.cookies.length && r.skipped) {
          log(`browser profile ${id}: the kept key opens nothing; syncing waits for the next import`);
          this.dropKey();
          return;
        }
        read = r.cookies;
      } else {
        if (found.blocked) return;
        read = await readSafariCookies(found.profile.cookies);
      }
      await this.apply(id, imported, ofSites(read.filter((c) => !expired(c, now)), imported.sites ? new Set(imported.sites) : undefined));
    } catch (err) {
      log(`browser profile ${id}: sync failed:`, String(err));
    }
  }

  private async apply(id: string, imported: Imported, cookies: BrowserCookie[]): Promise<void> {
    const ses = electronSession.fromPartition(profilePartition(id));
    const plan = planSync(cookies, await ses.cookies.get({}), this.copies.get(id) ?? {});
    let set = 0;
    let refused = 0;
    for (const c of plan.set) {
      try {
        await ses.cookies.set(setDetails(c));
        set += 1;
      } catch {
        refused += 1;
      }
    }
    for (const h of plan.remove) {
      await ses.cookies.remove(cookieUrl(h.domain ?? "", h.path ?? "/", h.secure === true), h.name).catch(() => {});
    }
    let held = imported.imported_sites;
    if (plan.set.length || plan.remove.length) {
      await ses.cookies.flushStore();
      this.copies.set(id, plan.copies);
      held = groupSites((await ses.cookies.get({})).map((c) => ({ host: c.domain ?? "", cookies: 1 }))).length;
      log(`browser profile ${id}: synced, ${set} cookies in, ${refused} refused, ${plan.remove.length} out`);
    }
    // Forgotten meanwhile: nothing to mark.
    if (this.store.get(id)) this.store.set(id, { ...imported, imported_sites: held, synced_at: nowSeconds() });
  }

  /** Forget a profile: what its session holds, what its sites were allowed,
   *  and that it was brought in, so no tab may show it any more. Not while
   *  it is being brought in: that would bring it back. */
  async forget(id: string): Promise<boolean> {
    if (this.importing.has(id)) return false;
    this.unfollow(id);
    await this.syncing.get(id);
    await forgetProfile(id);
    this.store.delete(id);
    this.copies.delete(id);
    // No Chrome profile left to keep in step: its key isn't kept either.
    if (!this.store.ids().some((p) => p.startsWith("chrome:"))) this.dropKey();
    log(`browser profile ${id} forgotten`);
    return true;
  }

  openFullDiskAccess(): void {
    this.shell.openSystemSettings(FULL_DISK_ACCESS);
  }

  /** Chrome's key for an import: kept, or asked of the Keychain (and kept). */
  private chromeKey(): Promise<Buffer> {
    const k = (this.key ??= Promise.resolve(this.sealedKey()).then(
      (sealed) =>
        sealed ??
        chromePassword()
          .then(chromeKey)
          .then((key) => {
            this.seal(key);
            return key;
          }),
    ));
    k.catch(() => {
      if (this.key === k) this.key = null;
    });
    return k;
  }

  /** Chrome's key for a sync: only one already kept, never the Keychain. */
  private async keptKey(): Promise<Buffer | null> {
    if (this.key) return this.key.catch(() => null);
    const sealed = this.sealedKey();
    if (sealed) this.key = Promise.resolve(sealed);
    return sealed;
  }

  private sealedKey(): Buffer | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const key = Buffer.from(safeStorage.decryptString(readFileSync(this.keyFile)), "base64");
      return key.length === 16 ? key : null;
    } catch {
      return null;
    }
  }

  private seal(key: Buffer): void {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      mkdirSync(dirname(this.keyFile), { recursive: true });
      writeFileSync(this.keyFile, safeStorage.encryptString(key.toString("base64")), { mode: 0o600 });
    } catch (err) {
      log("chrome key not kept:", String(err));
    }
  }

  private dropKey(): void {
    this.key = null;
    rmSync(this.keyFile, { force: true });
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
