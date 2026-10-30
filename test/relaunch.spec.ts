// relaunch.ts: where a restart into a new version comes back to (the
// conversation, the garden, the moments — the hash the web app reads as a
// place, client-shared/reloadLanding.ts `landingFromHash`), and which version
// this shell ran before (HostUpdate.updatedFrom). The pure rules, and the two
// files at their edges in a real temporary data directory.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PRODUCTION } from "../src/main/config";
import {
  LAST_VERSION_FILE,
  RELAUNCH_FILE,
  noteRelaunch,
  noteVersion,
  parseRelaunch,
  relaunchHash,
  relaunchUrl,
  takeRelaunch,
  updatedFrom,
} from "../src/main/relaunch";
import { initialUpdate, reduceUpdate, UpdateTracker } from "../src/main/updateState";
import type { HostUpdate } from "../src/shared/desktopHost.generated";
import { RESTART_LANDING_TTL } from "../src/shared/reloadLanding.generated";

const cfg = PRODUCTION;
const CONV = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MSG = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const T = 1_700_000_000_000;
const MIN = 60_000;

let dirs: string[] = [];
const userData = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mafold-relaunch-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
/** A file in the data directory as text, or null when there is none. */
const read = (d: string, name: string): string | null => (existsSync(join(d, name)) ? readFileSync(join(d, name), "utf8") : null);
const lastVersion = (d: string): string | null => read(d, LAST_VERSION_FILE)?.trim() ?? null;

describe("the hash worth coming back to", () => {
  it("is one of the shapes the web app writes: a conversation, a message in one, the garden, the moments", () => {
    for (const h of [`#${CONV}`, `#${CONV}/${MSG}`, `#${CONV.toUpperCase()}`, "#garden", "#moments"]) {
      expect(relaunchHash(`https://mafold.com/app${h}`, cfg), h).toBe(h);
    }
  });

  it("is read as the web app reads it, and kept as the app writes it: a pane's longer link is the pane, past a message nothing", () => {
    expect(relaunchHash("https://mafold.com/app#garden/x", cfg)).toBe("#garden");
    expect(relaunchHash("https://mafold.com/app#moments/y", cfg)).toBe("#moments");
    expect(relaunchHash(`https://mafold.com/app#${CONV}/`, cfg)).toBe(`#${CONV}`);
    expect(relaunchHash(`https://mafold.com/app#${CONV}/${MSG}/${MSG}`, cfg)).toBe(`#${CONV}/${MSG}`);
  });

  it("never brings the query along: an address with code= keeps only its hash", () => {
    expect(relaunchHash(`https://mafold.com/app?code=abc&state=dsk_1#${CONV}`, cfg)).toBe(`#${CONV}`);
    expect(relaunchHash(`https://mafold.com/app?code=abc#garden`, cfg)).toBe("#garden");
  });

  it("is nothing for any other hash, or none", () => {
    for (const u of [
      "https://mafold.com/app",
      "https://mafold.com/app#",
      "https://mafold.com/app#section", // a markdown anchor
      "https://mafold.com/app#join/abc123", // an invite: once is enough
      "https://mafold.com/app#GARDEN", // the panes' names are lower case, as the app reads them
      "https://mafold.com/app#Moments",
      `https://mafold.com/app#${CONV}?code=abc`, // a query inside the hash
      `https://mafold.com/app#${CONV}/not-a-message`,
      `https://mafold.com/app#${CONV.slice(0, -1)}`,
      "not a url",
    ]) {
      expect(relaunchHash(u, cfg), u).toBeNull();
    }
  });

  it("is nothing off the web origin: the offline page, the api, anywhere else", () => {
    expect(relaunchHash(`file:///Applications/Mafold.app/Contents/Resources/static/offline.html#${CONV}`, cfg)).toBeNull();
    expect(relaunchHash(`https://api.mafold.com/app#${CONV}`, cfg)).toBeNull();
    expect(relaunchHash(`https://example.com/app#${CONV}`, cfg)).toBeNull();
  });
});

describe("the note a restart leaves", () => {
  const note = (v: unknown) => JSON.stringify(v);

  // The same rule as every other landing (reloadLanding.ts `landingFresh`),
  // with the longer life an install in between asks for — the one number the
  // page's own landing for a restart keeps too (`RESTART_LANDING_TTL`).
  it("is read back within ten minutes", () => {
    expect(parseRelaunch(note({ hash: `#${CONV}`, at: T, from: "0.1.3" }), T + 1000)).toEqual({ hash: `#${CONV}`, at: T, from: "0.1.3" });
    expect(parseRelaunch(note({ hash: "#garden", at: T, from: "0.1.3" }), T + RESTART_LANDING_TTL - 1)).toEqual({ hash: "#garden", at: T, from: "0.1.3" });
    expect(RESTART_LANDING_TTL).toBe(10 * MIN);
  });

  it("has run out at ten minutes", () => {
    expect(parseRelaunch(note({ hash: `#${CONV}`, at: T, from: "0.1.3" }), T + RESTART_LANDING_TTL)).toBeNull();
    expect(parseRelaunch(note({ hash: `#${CONV}`, at: T, from: "0.1.3" }), T + 11 * MIN)).toBeNull();
  });

  it("is still this launch's when the clock went back since it was written (the install took seconds)", () => {
    expect(parseRelaunch(note({ hash: `#${CONV}`, at: T + 1000, from: "0.1.3" }), T)).toEqual({ hash: `#${CONV}`, at: T + 1000, from: "0.1.3" });
  });

  it("gives back the hash as the web app writes it", () => {
    expect(parseRelaunch(note({ hash: "#garden/x", at: T, from: "0.1.3" }), T)).toEqual({ hash: "#garden", at: T, from: "0.1.3" });
    expect(parseRelaunch(note({ hash: `#${CONV}/${MSG}/x`, at: T, from: "0.1.3" }), T)).toEqual({ hash: `#${CONV}/${MSG}`, at: T, from: "0.1.3" });
  });

  it("is nothing with a hash the web app does not write", () => {
    for (const hash of ["#section", "#join/abc", "#GARDEN", `${CONV}`, `#${CONV}?code=abc`, "", 7, null]) {
      expect(parseRelaunch(note({ hash, at: T, from: "0.1.3" }), T + 1000), String(hash)).toBeNull();
    }
  });

  it("is nothing when it is not JSON, or not that JSON", () => {
    for (const raw of ["", "{not json", "null", "[]", '"#garden"', note({ hash: "#garden" }), note({ hash: "#garden", at: "now" }), note({ hash: "#garden", at: null })]) {
      expect(parseRelaunch(raw, T), raw).toBeNull();
    }
  });
});

describe("where the window loads", () => {
  it("is the start page with the hash the note kept", () => {
    expect(relaunchUrl(cfg, `#${CONV}`)).toBe(`https://mafold.com/app#${CONV}`);
    expect(relaunchUrl(cfg, `#${CONV}/${MSG}`)).toBe(`https://mafold.com/app#${CONV}/${MSG}`);
    const local = { ...cfg, webOrigin: "http://127.0.0.1:3000", startUrl: "http://127.0.0.1:3000/app" };
    expect(relaunchUrl(local, "#moments")).toBe("http://127.0.0.1:3000/app#moments");
  });

  it("is the start page without a note, or with a hash that is not one of the app's", () => {
    expect(relaunchUrl(cfg, null)).toBe("https://mafold.com/app");
    expect(relaunchUrl(cfg, "#section")).toBe("https://mafold.com/app");
    expect(relaunchUrl(cfg, "?code=abc#garden")).toBe("https://mafold.com/app");
  });

  it("is the start page, as it is, when that is not on the web origin: a hash never makes a page the window may show", () => {
    // A start page off the web origin (the window would send it to the system
    // browser): a hash does not change that, so it is left off.
    expect(relaunchUrl({ ...cfg, startUrl: "http://127.0.0.1:3000/app" }, "#moments")).toBe("http://127.0.0.1:3000/app");
  });
});

describe("the note, on disk", () => {
  it("keeps only the hash of where the window was, when, and the version it left", () => {
    const d = userData();
    noteRelaunch(d, `https://mafold.com/app?code=abc#${CONV}`, "0.1.3", cfg, T);
    const raw = read(d, RELAUNCH_FILE);
    expect(raw === null ? null : JSON.parse(raw)).toEqual({ hash: `#${CONV}`, at: T, from: "0.1.3" });
    expect(raw).not.toContain("code");
  });

  it("is not written for the offline page, the list, or a hash the app does not write — and an older one goes", () => {
    const d = userData();
    for (const url of [`file:///x/static/offline.html#${encodeURIComponent('{"url":"https://mafold.com/app"}')}`, "https://mafold.com/app", "https://mafold.com/app#section"]) {
      writeFileSync(join(d, RELAUNCH_FILE), JSON.stringify({ hash: "#garden", at: T, from: "0.1.2" }));
      noteRelaunch(d, url, "0.1.3", cfg, T);
      expect(existsSync(join(d, RELAUNCH_FILE)), url).toBe(false);
    }
  });

  it("is read once: taken, it is gone", () => {
    const d = userData();
    noteRelaunch(d, `https://mafold.com/app#${CONV}`, "0.1.3", cfg, T);
    expect(takeRelaunch(d, T + MIN)).toEqual({ hash: `#${CONV}`, at: T, from: "0.1.3" });
    expect(existsSync(join(d, RELAUNCH_FILE))).toBe(false);
    expect(takeRelaunch(d, T + MIN)).toBeNull();
  });

  it("goes even when it is no use: run out, or unreadable", () => {
    const d = userData();
    noteRelaunch(d, `https://mafold.com/app#${CONV}`, "0.1.3", cfg, T);
    expect(takeRelaunch(d, T + 11 * MIN)).toBeNull();
    expect(existsSync(join(d, RELAUNCH_FILE))).toBe(false);

    writeFileSync(join(d, RELAUNCH_FILE), "{not json");
    expect(takeRelaunch(d, T)).toBeNull();
    expect(existsSync(join(d, RELAUNCH_FILE))).toBe(false);
  });

  it("is nothing when there is none", () => {
    expect(takeRelaunch(userData(), T)).toBeNull();
  });
});

describe("which version this shell came from", () => {
  it("is the last one that ran, when this one is newer", () => {
    expect(updatedFrom("0.1.3", "0.1.4")).toBe("0.1.3");
    expect(updatedFrom("0.1.9", "0.1.10")).toBe("0.1.9");
    expect(updatedFrom("0.9.0", "1.0.0")).toBe("0.9.0");
    // The beta line (updateChannel.ts): a release is newer than its betas.
    expect(updatedFrom("0.1.4-beta.1", "0.1.4")).toBe("0.1.4-beta.1");
    expect(updatedFrom("0.1.4-beta.2", "0.1.4-beta.10")).toBe("0.1.4-beta.2");
    expect(updatedFrom("0.1.3", "0.1.4-beta.1")).toBe("0.1.3");
  });

  it("is nothing for the same version, an older one (a downgrade), or nothing known", () => {
    expect(updatedFrom("0.1.4", "0.1.4")).toBeUndefined();
    expect(updatedFrom("0.1.5", "0.1.4")).toBeUndefined();
    expect(updatedFrom("0.1.4", "0.1.4-beta.3")).toBeUndefined();
    expect(updatedFrom("0.1.4-beta.10", "0.1.4-beta.2")).toBeUndefined();
    expect(updatedFrom(null, "0.1.4")).toBeUndefined();
    expect(updatedFrom("", "0.1.4")).toBeUndefined();
    expect(updatedFrom("banana", "0.1.4")).toBeUndefined();
    expect(updatedFrom("0.1", "0.1.4")).toBeUndefined();
  });

  it("is read from the data directory once per launch, which then remembers this one", () => {
    const d = userData();
    // A new install — or a shell that never wrote the file (0.1.3 and before).
    expect(noteVersion(d, "0.1.4")).toBeUndefined();
    expect(lastVersion(d)).toBe("0.1.4");
    // The next launch of the same version: nothing to say.
    expect(noteVersion(d, "0.1.4")).toBeUndefined();
    // Updated.
    expect(noteVersion(d, "0.1.5")).toBe("0.1.4");
    expect(lastVersion(d)).toBe("0.1.5");
    expect(noteVersion(d, "0.1.5")).toBeUndefined();
    // Downgraded: nothing to say, and the older one is what ran last.
    expect(noteVersion(d, "0.1.4")).toBeUndefined();
    expect(lastVersion(d)).toBe("0.1.4");
  });

  it("is nothing for a file that does not hold a version", () => {
    const d = userData();
    writeFileSync(join(d, LAST_VERSION_FILE), "{not a version}");
    expect(noteVersion(d, "0.1.4")).toBeUndefined();
    expect(lastVersion(d)).toBe("0.1.4");
  });

  it("reaches the page in every state the update goes through", () => {
    expect(initialUpdate("0.1.4", "0.1.3")).toEqual({ current: "0.1.4", phase: "idle", updatedFrom: "0.1.3" });
    expect(initialUpdate("0.1.4", undefined)).toEqual({ current: "0.1.4", phase: "idle" });
    let s: HostUpdate = initialUpdate("0.1.4", "0.1.3");
    const events: [string, unknown?][] = [["checking-for-update"], ["update-available", { version: "0.1.5" }], ["update-downloaded", { version: "0.1.5" }]];
    for (const [name, info] of events) {
      s = reduceUpdate(s, name, info, T);
      expect(s.updatedFrom, name).toBe("0.1.3");
    }
    const sent: HostUpdate[] = [];
    const t = new UpdateTracker("0.1.4", (u) => sent.push(u), "0.1.3");
    expect(t.state).toEqual({ current: "0.1.4", phase: "idle", updatedFrom: "0.1.3" });
    t.feed("checking-for-update");
    expect(sent).toEqual([{ current: "0.1.4", phase: "checking", updatedFrom: "0.1.3" }]);
  });
});
