// Updates of the shell itself. The web app updates by being the live site; this
// is only for the shell (Electron, the bridge, menus). electron-updater reads a
// generic feed on our CDN (`latest-mac.yml` / `latest.yml`), downloads in the
// background, and the person restarts when it suits them — from the tray or the
// app menu, or simply on their next quit. An internal machine may read the
// feed's beta files instead (updateChannel.ts).
//
// The page hears about it too (the `update` cap): electron-updater's events are
// reduced to one `HostUpdate` (updateState.ts), sent on every change and again
// whenever the page starts listening, and the page may restart into a ready
// version or ask for a check. That half is wired with or without a feed, so the
// e2e suite (unpackaged, no feed) drives it with the same events
// (index.ts `updateEvent`); only listening to the feed needs a packaged app.
//
// A page that listens offers the restart itself (the pill), and only it knows
// whether one now would cut off an upload or a dictation. So the tray's and the
// menu's "Restart to Update" ask it (`ask`) instead of quitting; while its
// window is in front there is no system notification, and otherwise (in the
// tray, minimised, behind another app) a click on one only brings the window
// forward. A page that listens to nothing (or no longer: its `off`), is on its
// way out, or stopped answering gets the restart at once, as before
// (updateState.ts `restartAction`).
//
// A restart comes back where the person was: just before it, the window's
// place and the page's conversation are written down (`beforeInstall`,
// relaunch.ts), and the new version opens there and tells the page which
// version it came from (`updatedFrom`).
//
// Windows builds are not code-signed (owner, 2026-10-05), so there is no
// publisher to verify: integrity rests on the sha512 in `latest.yml` served
// over HTTPS, and write access to the feed's prefix belongs to the release CI
// alone.

import { appendFileSync } from "node:fs";
import { app } from "electron";
import { autoUpdater } from "electron-updater";

import { log } from "./log";
import { notifyUpdateReady } from "./notify";
import type { Shell } from "./shell";
import { feedFor } from "./updateChannel";
import { newlyReady, notifyReady, restartAction, UPDATE_EVENTS, UpdateTracker, type PageNow } from "./updateState";
import type { HostUpdate } from "../shared/desktopHost.generated";

const EVERY_MS = 4 * 60 * 60_000;

export interface Updater {
  /** What the page is told, now. */
  state(): HostUpdate;
  /** Quit and restart into the downloaded version. False — and nothing
   *  happens — unless one is ready. */
  install(): boolean;
  /** Ask the feed now; resolves with the state once it has answered (at once
   *  without a feed). */
  check(): Promise<HostUpdate>;
  /** One electron-updater event, by its name: the feed's, or e2e's. */
  feed(name: string, info?: unknown): void;
  /** A restart asked for outside the page: the tray's or the menu's item
   *  (`menu`), a click on the "ready" notification (`notice`). */
  askRestart(from: "menu" | "notice"): void;
}

export interface UpdaterOptions {
  /** The version that ran before this one, on the first run after updating
   *  (relaunch.ts `noteVersion`): every state of this run says so. */
  updatedFrom?: string;
  /** Runs once a restart into the downloaded version is certain to be tried,
   *  before anything quits: index.ts writes down where the window is and
   *  where the page was, for the launch after it (relaunch.ts). */
  beforeInstall?: () => void;
}

let asker: ((from: "menu" | "notice") => void) | null = null;

/** The tray's and the menu's "Restart to Update". */
export function restartToUpdate(): void {
  asker?.("menu");
}

export function initUpdater(shell: Shell, os: "macos" | "windows" | "linux", opts: UpdaterOptions = {}): Updater {
  const tracker = new UpdateTracker(shell.version, (u) => shell.emit("update", JSON.stringify(u)), opts.updatedFrom);
  shell.onSubscribe((name) => {
    if (name === "update") shell.emit("update", JSON.stringify(tracker.state));
  });

  const page = (): PageNow => {
    const w = shell.window;
    return {
      listening: shell.isSubscribed("update"),
      // Shown is not seen: behind another app's window the pill is there, and
      // nobody looks at it.
      inFront: !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused(),
      leaving: shell.pageLeaving,
      hung: shell.pageHung,
    };
  };

  const feed = (name: string, info?: unknown) => {
    const before = tracker.state;
    if (!tracker.feed(name, info)) return;
    const version = newlyReady(before, tracker.state);
    if (version) {
      log("update ready:", version);
      if (notifyReady(page())) notifyUpdateReady(shell, os, () => askRestart("notice"));
    }
    // The tray and the menu offer the restart while a version is ready.
    const ready = tracker.state.phase === "ready";
    if (ready === shell.updateReady) return;
    shell.updateReady = ready;
    shell.changed();
  };

  // Set once the feed is wired (below).
  let checkFeed: (() => Promise<void>) | null = null;
  let installing = false;
  const install = (): boolean => {
    if (tracker.state.phase !== "ready") return false;
    const testLog = shell.cfg.test?.externalLog;
    if (!testLog && !checkFeed) return false;
    try {
      opts.beforeInstall?.();
    } catch (e) {
      log("before the update's restart:", e); // the restart goes ahead regardless
    }
    // Under e2e the restart is written down instead (like Shell.openExternal).
    if (testLog) {
      appendFileSync(testLog, "update\tinstall\n");
      return true;
    }
    shell.quitting = true;
    installing = true;
    try {
      autoUpdater.quitAndInstall();
      return true;
    } catch (e) {
      log("update install failed:", e);
      installing = false;
      shell.quitting = false;
      return false;
    }
  };
  const askRestart = (from: "menu" | "notice") => {
    if (tracker.state.phase !== "ready") return;
    const action = restartAction(page(), from);
    if (action === "install") {
      install();
      return;
    }
    shell.showWindow();
    // `ask` rides this one event: the page restarts unless something would be
    // cut off by it. Without it the page just hears the state again — its pill
    // comes out, even if the window had been in the tray all along.
    shell.emit("update", JSON.stringify(action === "ask" ? { ...tracker.state, ask: true } : tracker.state));
  };
  asker = askRestart;
  const updater: Updater = {
    state: () => tracker.state,
    install,
    check: async () => {
      await checkFeed?.();
      return tracker.state;
    },
    feed,
    askRestart,
  };

  if (!shell.cfg.updateFeed || !app.isPackaged) return updater;
  const source = feedFor(app.getPath("userData"), shell.cfg.updateFeed);
  if (source.channel) log("updates: the", source.channel, "channel");
  autoUpdater.setFeedURL(source);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log("updater:", m),
    warn: (m: unknown) => log("updater warn:", m),
    error: (m: unknown) => log("updater error:", m),
    debug: () => {},
  };
  for (const name of UPDATE_EVENTS) autoUpdater.on(name, (info?: unknown) => feed(name, info));
  // An install that did not quit after all (macOS hands it to Squirrel, which
  // can still refuse): closing the window must go back to hiding it (window.ts).
  autoUpdater.on("error", () => {
    if (!installing) return;
    installing = false;
    shell.quitting = false;
  });
  checkFeed = () => autoUpdater.checkForUpdates().then(
    () => {},
    (e) => log("update check failed:", e),
  );
  setTimeout(() => void checkFeed?.(), 15_000).unref();
  setInterval(() => void checkFeed?.(), EVERY_MS).unref();
  return updater;
}
