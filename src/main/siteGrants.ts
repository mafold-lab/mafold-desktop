// What the person said a site may use (camera, microphone, location, …),
// remembered across restarts. The questions are sites.ts; this is the file.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "./log";

type Said = Record<string, Record<string, boolean>>;

export class SiteGrants {
  private said: Said = Object.create(null) as Said;

  constructor(private file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      for (const [origin, asks] of Object.entries(raw)) {
        if (!asks || typeof asks !== "object") continue;
        const kept: Record<string, boolean> = {};
        for (const [ask, allowed] of Object.entries(asks)) if (typeof allowed === "boolean") kept[ask] = allowed;
        this.said[origin] = kept;
      }
    } catch {
      // Nothing saved yet, or nothing readable: every site asks again.
    }
  }

  get(origin: string, ask: string): boolean | undefined {
    return this.said[origin]?.[ask];
  }

  set(origin: string, ask: string, allowed: boolean): void {
    this.said[origin] = { ...this.said[origin], [ask]: allowed };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const next = `${this.file}.next`;
      writeFileSync(next, JSON.stringify(this.said));
      renameSync(next, this.file);
    } catch (err) {
      log("site permissions not saved:", String(err));
    }
  }

  clear(): void {
    this.said = Object.create(null) as Said;
    rmSync(this.file, { force: true });
  }
}
