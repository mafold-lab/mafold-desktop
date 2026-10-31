// updater.ts's one line between the data directory and the feed: what a
// packaged shell hands electron-updater's `setFeedURL` at launch is
// feedFor(its userData, the feed), as it is — so which line a machine is on is
// decided by that directory alone, in the shell and not only in the pure
// function (updateChannel.spec.ts). No Electron here (vitest.config.mts):
// `app` is stood in for as a packaged app whose userData is a temporary
// directory, `autoUpdater` writes down what it was handed, and the URL that
// would then be fetched comes from electron-updater's own provider (feedFile.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PRODUCTION } from "../src/main/config";
import type { Shell } from "../src/main/shell";
import { CHANNEL_FILE, feedFor, feedOptions, type FeedOptions } from "../src/main/updateChannel";
import { initUpdater } from "../src/main/updater";
import { askedUrl } from "./feedFile";

const h = vi.hoisted(() => ({ packaged: true, userData: "", handed: [] as FeedOptions[] }));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.packaged;
    },
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`the updater asked for app.getPath("${name}")`);
      return h.userData;
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    setFeedURL: (options: FeedOptions) => {
      h.handed.push(options);
    },
    on: () => {},
    checkForUpdates: () => Promise.resolve(null),
  },
}));

// The "ready" notification is not this test's business (and needs Electron).
vi.mock("../src/main/notify", () => ({ notifyUpdateReady: () => {} }));

const FEED = PRODUCTION.updateFeed!;

let dirs: string[] = [];
const userData = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mafold-updater-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  h.packaged = true;
});

/** Start the updater as a shell launching with data directory `dir` (and
 *  `updateFeed`, the production one by default); what `setFeedURL` got. */
function launch(dir: string, updateFeed: string | null = FEED): FeedOptions[] {
  h.userData = dir;
  h.handed = [];
  const shell = { version: "0.1.3", cfg: { ...PRODUCTION, updateFeed, test: null }, emit: () => {}, onSubscribe: () => {} } as unknown as Shell;
  // Its first and periodic checks are timers; they never run here.
  vi.useFakeTimers();
  try {
    initUpdater(shell, "macos");
  } finally {
    vi.useRealTimers();
  }
  return h.handed;
}

/** The URLs electron-updater then fetches, on macOS and on Windows. */
const fetched = (options: FeedOptions): Promise<string[]> => Promise.all([askedUrl(options, "darwin"), askedUrl(options, "win32")]);

describe("what a packaged shell hands its updater", () => {
  it("is the feed as it always was, on a machine that never opted in", async () => {
    const d = userData();
    const handed = launch(d);
    expect(handed).toEqual([feedFor(d, FEED)]);
    expect(handed).toEqual([feedOptions(FEED, "stable")]);
    expect(handed[0]).not.toHaveProperty("channel");
    expect(await fetched(handed[0])).toEqual(["https://cdn.mafold.com/desktop/stable/latest-mac.yml", "https://cdn.mafold.com/desktop/stable/latest.yml"]);
  });

  it("is the beta files of the same feed, on a machine whose data directory says beta", async () => {
    const d = userData();
    writeFileSync(join(d, CHANNEL_FILE), '{"channel":"beta"}\n');
    const handed = launch(d);
    expect(handed).toEqual([feedFor(d, FEED)]);
    expect(handed).toEqual([feedOptions(FEED, "beta")]);
    expect(await fetched(handed[0])).toEqual(["https://cdn.mafold.com/desktop/stable/beta-mac.yml", "https://cdn.mafold.com/desktop/stable/beta.yml"]);
  });

  it("is nothing at all unpackaged (npm start, e2e) or without a feed", () => {
    const d = userData();
    writeFileSync(join(d, CHANNEL_FILE), '{"channel":"beta"}\n');
    h.packaged = false;
    expect(launch(d)).toEqual([]);
    h.packaged = true;
    expect(launch(d, null)).toEqual([]);
  });
});
