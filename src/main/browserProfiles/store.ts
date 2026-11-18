// Which profiles have been brought in, when, for which sites, and when last
// synced: `browser-profiles.json` in the app's data. Only that: the cookies
// themselves live in each profile's session (Chromium's own store), and no
// key or value is ever written here. The list
// is also what lets a profile's session be shown at all (policy.ts
// `mayAttachSite`): a profile that isn't here has no tabs.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "../log";

export interface Imported {
  imported_at: number;
  imported_sites: number;
  /** The sites it was brought in for, when it was some of them (Choose
   *  sites); absent = the whole profile, new sites included. */
  sites?: string[];
  /** When it was last synced with the browser (unix seconds). */
  synced_at?: number;
}

export class ProfileStore {
  private saved = new Map<string, Imported>();

  constructor(private file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      for (const [id, v] of Object.entries(raw)) {
        const o = v as Partial<Imported> | null;
        if (o && typeof o.imported_at === "number" && typeof o.imported_sites === "number") {
          const sites = Array.isArray(o.sites) ? o.sites.filter((s): s is string => typeof s === "string") : undefined;
          this.saved.set(id, {
            imported_at: o.imported_at,
            imported_sites: o.imported_sites,
            ...(sites ? { sites } : null),
            ...(typeof o.synced_at === "number" ? { synced_at: o.synced_at } : null),
          });
        }
      }
    } catch {
      // Nothing brought in yet, or nothing readable: every profile starts new.
    }
  }

  get(id: string): Imported | undefined {
    return this.saved.get(id);
  }

  ids(): string[] {
    return [...this.saved.keys()];
  }

  set(id: string, v: Imported): void {
    this.saved.set(id, v);
    this.write();
  }

  delete(id: string): void {
    if (this.saved.delete(id)) this.write();
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const next = `${this.file}.next`;
      writeFileSync(next, JSON.stringify(Object.fromEntries(this.saved)));
      renameSync(next, this.file);
    } catch (err) {
      log("browser profiles not saved:", String(err));
    }
  }
}
