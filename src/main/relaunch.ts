// A restart into a new version comes back where the person was, and the page
// hears which version the shell came from.
//
// Until now every new process opened the start page (config.ts `startUrl`) —
// the chat list — whatever had been open. Now the restart that installs an
// update (updater.ts `install`: the pill, the tray's or the menu's "Restart to
// Update", a click on the notification) first writes down where the window is:
//
//   relaunch.json   {"hash":"#<conversation>","at":<ms>,"from":"0.1.4"}
//
// and the next launch opens the start page with that hash, if the note is
// under RESTART_LANDING_TTL old — read once, then deleted, whatever it says. Only
// the hash, and only one the web app reads as a place — the open
// conversation, a message in it, the garden, the moments — read the way it
// reads it and kept the way it writes it: client-shared/reloadLanding.ts
// `landingFromHash` / `landingHash`, the same functions mafold-web AppShell
// uses, compiled here from a generated copy (scripts/sync-shared.mjs). Never
// the query, which may carry an OAuth callback's `code=` that must not be
// replayed, and never another origin's address (the offline page). How long
// a note stays the next launch's is that file's rule and number too
// (`landingFresh`, `RESTART_LANDING_TTL`: a restart's longer life). Panes the
// hash does not hold (the wallet, Settings) are the page's to keep: it writes
// its own landing before asking for the restart, for the same life.
//
//   last-version    0.1.4
//
// is the version that ran last. At launch a newer version than that is
// `HostUpdate.updatedFrom` — however it got installed: a restart, or quitting
// (electron-updater installs then too). No file (a new install, or a shell
// from before this one, which never wrote it), the same version, or an older
// one (a downgrade): nothing to say. The page shows "up to date" once for it.
//
// Pure except for the file reads and writes at the edges, like windowState.ts;
// test/relaunch.spec.ts covers both, e2e/relaunch.spec.ts the shell around them.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { landingFresh, landingFromHash, landingHash, RESTART_LANDING_TTL } from "../shared/reloadLanding.generated";
import type { ShellConfig } from "./config";
import { log } from "./log";
import { decideNavigation } from "./policy";

type Origins = Pick<ShellConfig, "webOrigin" | "apiOrigin">;

/** In userData, beside window-state.json: where a restart into a new version
 *  comes back to. */
export const RELAUNCH_FILE = "relaunch.json";
/** In userData: the version that ran last. */
export const LAST_VERSION_FILE = "last-version";

export interface RelaunchNote {
  /** A hash the web app reads as a place, as it writes it (`appHash`), with its `#`. */
  hash: string;
  /** When it was written, ms since the epoch. */
  at: number;
  /** The version that wrote it. */
  from: string;
}

/** `hash` as the web app writes it, if the app reads it as a place
 *  (reloadLanding.ts `landingFromHash`, then `landingHash`) — null for
 *  anything else, and for anything that is not a hash. */
function appHash(hash: unknown): string | null {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;
  const to = landingFromHash(hash);
  return (to && landingHash(to)) || null;
}

/** The hash of the page at `url` worth coming back to — null off the web
 *  origin, without a hash, or with one the web app does not read as a place. */
export function relaunchHash(url: string, o: Origins): string | null {
  if (decideNavigation(url, o) !== "allow") return null;
  try {
    return appHash(new URL(url).hash);
  } catch {
    return null;
  }
}

/** The note in `text`, if it is one and still the next launch's at `now`:
 *  younger than reloadLanding.ts `RESTART_LANDING_TTL` (a page reload's is a
 *  minute). Installing takes seconds; one older is from a restart that never
 *  happened (an install that failed), and the person has moved on since. */
export function parseRelaunch(text: string, now: number): RelaunchNote | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { hash, at, from } = v as { hash?: unknown; at?: unknown; from?: unknown };
  const kept = appHash(hash);
  if (!kept || typeof at !== "number" || !landingFresh(at, now, RESTART_LANDING_TTL)) return null;
  return { hash: kept, at, from: typeof from === "string" ? from : "" };
}

/** What the window opens: the start page, with `hash` if the web app reads it
 *  as a place — and only if the result is still a page the window may show.
 *  (Not reloadLanding.ts `landingUrl`: that is a web page's own reload, which
 *  carries only the conversation in the hash; this brings back the hash the
 *  page showed, the garden's and the moments' too.) */
export function relaunchUrl(cfg: Pick<ShellConfig, "startUrl" | "webOrigin" | "apiOrigin">, hash: string | null): string {
  const kept = appHash(hash);
  if (!kept) return cfg.startUrl;
  try {
    const u = new URL(cfg.startUrl);
    u.hash = kept;
    const url = u.toString();
    return decideNavigation(url, cfg) === "allow" ? url : cfg.startUrl;
  } catch {
    return cfg.startUrl;
  }
}

/** Write down where the window at `url` is, for the launch after a restart
 *  into a new version. Nothing worth coming back to: no note — and none left
 *  over from before. */
export function noteRelaunch(dir: string, url: string, version: string, o: Origins, now: number): void {
  const file = join(dir, RELAUNCH_FILE);
  const hash = relaunchHash(url, o);
  try {
    if (!hash) {
      rmSync(file, { force: true });
      return;
    }
    const note: RelaunchNote = { hash, at: now, from: version };
    writeFileSync(file, JSON.stringify(note));
  } catch (e) {
    log("could not write where to come back to:", e);
  }
}

/** The note a restart left, if it is still this launch's. Read once: the file
 *  goes either way. */
export function takeRelaunch(dir: string, now: number): RelaunchNote | null {
  const file = join(dir, RELAUNCH_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null; // none
  }
  try {
    rmSync(file, { force: true });
  } catch (e) {
    log("could not delete", RELAUNCH_FILE, e);
  }
  return parseRelaunch(text, now);
}

/** `X.Y.Z` or `X.Y.Z-pre.release` (the beta line, updateChannel.ts); build
 *  metadata after `+` does not count. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver order of `a` and `b` (negative: `a` is older), or null when either
 *  is not a version. */
function compareVersions(a: string, b: string): number | null {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  const p: string | undefined = x[4];
  const q: string | undefined = y[4];
  // A release is newer than its pre-releases.
  if (p === undefined || q === undefined) return p === q ? 0 : p === undefined ? 1 : -1;
  const ps = p.split(".");
  const qs = q.split(".");
  for (let i = 0; ; i++) {
    // All equal so far: the one with more identifiers is newer.
    if (i >= ps.length || i >= qs.length) return Math.sign(ps.length - qs.length);
    const m = ps[i];
    const n = qs[i];
    const mn = /^\d+$/.test(m);
    const nn = /^\d+$/.test(n);
    if (mn && nn) {
      const d = Number(m) - Number(n);
      if (d) return Math.sign(d);
    } else if (mn !== nn) {
      return mn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (m !== n) {
      return m < n ? -1 : 1;
    }
  }
}

/** `HostUpdate.updatedFrom`: `last` when `current` is newer than it; nothing
 *  for the same version, an older one, or none known. */
export function updatedFrom(last: string | null, current: string): string | undefined {
  if (!last) return undefined;
  const order = compareVersions(last, current);
  return order !== null && order < 0 ? last : undefined;
}

/** At launch: the version that ran before this one, if this one is newer
 *  (`updatedFrom`) — and this one written down for the next launch. */
export function noteVersion(dir: string, current: string): string | undefined {
  const file = join(dir, LAST_VERSION_FILE);
  let last: string | null = null;
  try {
    last = readFileSync(file, "utf8").trim();
  } catch {
    /* a new install, or a shell that never wrote it */
  }
  if (last !== current) {
    try {
      // Early in the launch: the directory may not be there yet on a new install.
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, current + "\n");
    } catch (e) {
      log("could not write the version:", e);
    }
  }
  return updatedFrom(last, current);
}
