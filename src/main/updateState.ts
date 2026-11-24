// What the page is told about the shell's own update (`HostUpdate`), reduced
// from electron-updater's events. Pure apart from the progress timer, so
// test/updateState.spec.ts covers it without Electron; updater.ts feeds it the
// real feed's events and e2e feeds it the same names (index.ts `updateEvent`).
//
// Three rules the page depends on:
// - `ready` stays. The shell checks again every four hours (updater.ts), and
//   each check starts with `checking-for-update` and may end in `error`; none
//   of that takes a downloaded update back. Only a DIFFERENT version
//   downloaded replaces `next` — it is the one a restart would install
//   (electron-updater keeps the last download).
// - The same version downloaded again is no news: electron-updater says
//   `update-downloaded` again for its cached file on every later check.
// - Download progress reaches the page at most every PROGRESS_EVERY_MS.
//
// And who restarts: a page that listens takes the restart from the tray, the
// menu and the notification, because it knows what one now would cut off
// (`restartAction`, `notifyReady`); without one — or with one on its way out,
// or hung — the shell restarts at once.

import type { HostUpdate } from "../shared/desktopHost.generated";

export const PROGRESS_EVERY_MS = 500;

/** The electron-updater events `reduceUpdate` understands. */
export const UPDATE_EVENTS = [
  "checking-for-update",
  "update-available",
  "download-progress",
  "update-downloaded",
  "update-not-available",
  "update-cancelled",
  "error",
] as const;

/** Where the state starts at launch: `updatedFrom` is the version that ran
 *  before, on the first run after updating (relaunch.ts `noteVersion`). It
 *  stays in every state after (`keep`), so a page that starts listening later
 *  in this run hears it too. */
export const initialUpdate = (current: string, updatedFrom?: string): HostUpdate => ({
  current,
  phase: "idle",
  ...(updatedFrom !== undefined ? { updatedFrom } : {}),
});

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** `info.version` from the feed, if it is one. */
const versionOf = (info: unknown): string | null => {
  const v = info && typeof info === "object" ? (info as { version?: unknown }).version : undefined;
  return typeof v === "string" && VERSION_RE.test(v) ? v : null;
};

/** `info.percent` as a whole number 0–100, if it is a number. */
const percentOf = (info: unknown): number | null => {
  const p = info && typeof info === "object" ? (info as { percent?: unknown }).percent : undefined;
  return typeof p === "number" && Number.isFinite(p) ? Math.max(0, Math.min(100, Math.floor(p))) : null;
};

/** What carries over from one phase to the next. */
const keep = (s: HostUpdate): Omit<HostUpdate, "phase"> => ({
  current: s.current,
  ...(s.checkedAt !== undefined ? { checkedAt: s.checkedAt } : {}),
  ...(s.updatedFrom !== undefined ? { updatedFrom: s.updatedFrom } : {}),
});

/**
 * The state after one electron-updater event (`name` is its event name, `info`
 * what came with it). Returns `s` itself when nothing changed — the caller's
 * test for "anything to tell".
 */
export function reduceUpdate(s: HostUpdate, name: string, info: unknown, now: number): HostUpdate {
  if (s.phase === "ready") {
    const v = name === "update-downloaded" ? versionOf(info) : null;
    return v && v !== s.next ? { ...keep(s), phase: "ready", next: v } : s;
  }
  const downloading = s.phase === "downloading";
  switch (name) {
    case "checking-for-update":
      return downloading || s.phase === "checking" ? s : { ...keep(s), phase: "checking" };
    case "update-available": {
      const v = versionOf(info);
      if (!v || (downloading && v === s.next)) return s;
      return { ...keep(s), phase: "downloading", next: v, percent: 0, checkedAt: now };
    }
    case "download-progress": {
      const p = percentOf(info);
      if (p === null || (downloading && p === s.percent)) return s;
      return { ...keep(s), phase: "downloading", ...(s.next !== undefined ? { next: s.next } : {}), percent: p };
    }
    case "update-downloaded": {
      const v = versionOf(info);
      return v ? { ...keep(s), phase: "ready", next: v } : s;
    }
    case "update-not-available":
      // A download already under way carries on regardless.
      return downloading ? s : { ...keep(s), phase: "idle", checkedAt: now };
    case "update-cancelled":
      return downloading ? { ...keep(s), phase: "idle" } : s;
    case "error":
      return s.phase === "error" ? s : { ...keep(s), phase: "error" };
    default:
      return s;
  }
}

/**
 * The version `before` → `after` made ready, if any: the first one ready, or a
 * different one after it — what the shell announces, once per version.
 */
export const newlyReady = (before: HostUpdate, after: HostUpdate): string | null =>
  after.phase === "ready" && after.next !== undefined && !(before.phase === "ready" && before.next === after.next) ? after.next : null;

/** The main window's page, as the restart's doors outside it see it. */
export interface PageNow {
  /** It listens to `update`: it offers the restart itself (the pill), and
   *  knows whether one now would cut off an upload, a dictation, an edit. */
  listening: boolean;
  /** The window is in front of the person — shown, not minimised, and the
   *  focused window. Not in the tray, and not behind another app's window:
   *  only then is the pill seen. */
  inFront: boolean;
  /** Another document is loading in its place (shell.ts `leavingDocument`):
   *  an `ask` sent now would leave with it, and the page replacing it would
   *  never hear it. */
  leaving: boolean;
  /** The renderer stopped answering (`unresponsive`) and has not come back. */
  hung: boolean;
}

/** The page can take the restart: it listens, is staying, and answers. */
const takesRestart = (p: PageNow): boolean => p.listening && !p.leaving && !p.hung;

/**
 * What a restart asked for outside the page does — the tray's or the menu's
 * "Restart to Update" (`menu`), a click on the "ready" notification (`notice`):
 * - `ask`: bring the window forward and hand it to the page (`update` with
 *   `ask`), which restarts unless something would be cut off, and says so;
 * - `show`: bring the window forward — its pill offers the restart;
 * - `install`: restart now, as before the page offered it — when no page
 *   listens (an older one, the offline page, one still loading, the pill
 *   switched off), it is on its way out, or it stopped answering. Quitting
 *   still installs regardless.
 */
export const restartAction = (p: PageNow, from: "menu" | "notice"): "ask" | "show" | "install" =>
  !takesRestart(p) ? "install" : from === "menu" ? "ask" : "show";

/** Whether a version just ready goes to the system's notifications: not while
 *  a page that offers it is in front of the person — a window in the tray,
 *  minimised or behind another app's still gets one. */
export const notifyReady = (p: PageNow): boolean => !takesRestart(p) || !p.inFront;

/** Only the bar moved: same phase, same version, another percent. */
const onlyProgress = (a: HostUpdate, b: HostUpdate): boolean => a.phase === "downloading" && b.phase === "downloading" && a.next === b.next;

/**
 * The current state, and `send` for every change: at once, except download
 * progress, which waits until PROGRESS_EVERY_MS have passed since the last send
 * and then sends the newest. Anything else sent meanwhile carries it along.
 */
export class UpdateTracker {
  private s: HostUpdate;
  private sentAt = Number.NEGATIVE_INFINITY;
  private later: ReturnType<typeof setTimeout> | null = null;

  constructor(
    current: string,
    private readonly send: (u: HostUpdate) => void,
    updatedFrom?: string,
  ) {
    this.s = initialUpdate(current, updatedFrom);
  }

  get state(): HostUpdate {
    return this.s;
  }

  /** One electron-updater event. True when it changed the state. */
  feed(name: string, info?: unknown): boolean {
    const next = reduceUpdate(this.s, name, info, Date.now());
    if (next === this.s) return false;
    const soon = onlyProgress(this.s, next);
    this.s = next;
    if (!soon) this.sendNow();
    else if (!this.later) {
      const wait = this.sentAt + PROGRESS_EVERY_MS - Date.now();
      if (wait <= 0) this.sendNow();
      else this.later = setTimeout(() => this.sendNow(), wait);
    }
    return true;
  }

  private sendNow(): void {
    if (this.later) clearTimeout(this.later);
    this.later = null;
    this.sentAt = Date.now();
    this.send(this.s);
  }
}
