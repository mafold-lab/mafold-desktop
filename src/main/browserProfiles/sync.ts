// Keeping a profile brought in the way its browser has it (ops 11-18 "Build
// it, always on"): after the import, what changes in Chrome or Safari comes
// over by itself, one way only. The browser's files are watched (index.ts);
// this decides, from what the browser holds now, what Mafold's session holds
// now and what was copied last time, which cookies to set and which to take
// away. Pure, so test/browserProfiles covers every rule without Electron.
//
// The rule, cookie by cookie:
// - the browser's value is the one copied last time: the browser hasn't
//   changed it, so Mafold's is left alone, even where a site has since
//   refreshed it here;
// - otherwise (a new login, or one the browser changed): it is copied;
// - copied last time but gone from the browser (signed out, or expired): it
//   goes here too, unless Mafold's value is no longer the copied one — then
//   the site has moved on here, and that login is Mafold's own.
//
// What was copied is remembered as fingerprints (`Copies`), never as values:
// a cookie's place and value each hashed, kept by site so an import of a few
// sites replaces only theirs.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log } from "../log";
import { registrableDomain, type BrowserCookie } from "./cookies";

/** site → (cookie place fingerprint → value fingerprint). */
export type Copies = Record<string, Record<string, string>>;

/** A cookie as Electron's `cookies.get` gives it: what the plan reads of it. */
export interface HeldCookie {
  domain?: string;
  hostOnly?: boolean;
  name: string;
  path?: string;
  value: string;
  secure?: boolean;
}

const fp = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Where a cookie lives, as the browser writes its host: a leading dot for a
 *  domain cookie. Electron's and the browser's come out the same. */
const placeOf = (host: string, name: string, path: string): string => fp(`${host.toLowerCase()}\0${name}\0${path || "/"}`);

export const browserPlace = (c: Pick<BrowserCookie, "host" | "name" | "path">): string => placeOf(c.host, c.name, c.path);

export function heldPlace(c: HeldCookie): string {
  const bare = (c.domain ?? "").replace(/^\./, "");
  return placeOf(c.hostOnly ? bare : `.${bare}`, c.name, c.path ?? "/");
}

export const valueFp = (value: string): string => fp(value);

/** What an import copied: every cookie it set, by site. */
export function copiesOf(cookies: readonly BrowserCookie[]): Copies {
  const out: Copies = {};
  for (const c of cookies) (out[registrableDomain(c.host)] ??= {})[browserPlace(c)] = valueFp(c.value);
  return out;
}

export interface Plan {
  set: BrowserCookie[];
  remove: HeldCookie[];
  /** What is copied once the plan is carried out. */
  copies: Copies;
}

/**
 * From the browser's live cookies (already only the profile's sites), what
 * Mafold's session holds, and what was copied last time: what to do. A site
 * the browser no longer has is checked like any other, cookie by cookie, and
 * leaves `copies` once nothing of it is copied.
 */
export function planSync(browser: readonly BrowserCookie[], held: readonly HeldCookie[], last: Copies): Plan {
  const copies: Copies = {};
  const set: BrowserCookie[] = [];
  const seen = new Set<string>();
  for (const c of browser) {
    const site = registrableDomain(c.host);
    const place = browserPlace(c);
    const v = valueFp(c.value);
    seen.add(place);
    if (last[site]?.[place] !== v) set.push(c);
    (copies[site] ??= {})[place] = v;
  }
  const here = new Map<string, HeldCookie>();
  for (const h of held) here.set(heldPlace(h), h);
  const remove: HeldCookie[] = [];
  for (const places of Object.values(last)) {
    for (const [place, v] of Object.entries(places)) {
      if (seen.has(place)) continue;
      const h = here.get(place);
      if (h && valueFp(h.value) === v) remove.push(h);
    }
  }
  return { set, remove, copies };
}

/** `copies` with `sites`' replaced by `fresh` (an import of only those), or
 *  all of it replaced (an import of the whole profile). */
export function mergeCopies(last: Copies, fresh: Copies, sites?: ReadonlySet<string>): Copies {
  if (!sites) return fresh;
  const out: Copies = {};
  for (const [site, places] of Object.entries(last)) if (!sites.has(site)) out[site] = places;
  return { ...out, ...fresh };
}

/** Each profile's copies, a file of its own under the app's data
 *  (`browser-profiles/copies/<id>.json`), read when its sync needs it. */
export class CopyStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]+/g, "_")}.json`);
  }

  /** Null when nothing was ever kept for it: a profile brought in before
   *  syncing existed, whose first sync copies everything the browser has. */
  get(id: string): Copies | null {
    try {
      const raw = JSON.parse(readFileSync(this.file(id), "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      return raw as Copies;
    } catch {
      return null;
    }
  }

  set(id: string, copies: Copies): void {
    const file = this.file(id);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.next`, JSON.stringify(copies));
      renameSync(`${file}.next`, file);
    } catch (err) {
      log("browser profile copies not saved:", String(err));
    }
  }

  delete(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}

/** When a profile's next sync may run, asked at `now` (ms): a moment after
 *  the browser last wrote (it writes in bursts), and not sooner than `gap`
 *  after the last one started. */
export function nextRun(now: number, lastStart: number | undefined, settle = 3_000, gap = 20_000): number {
  return Math.max(now + settle, lastStart === undefined ? 0 : lastStart + gap);
}
