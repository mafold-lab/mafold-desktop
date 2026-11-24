import { afterEach, describe, expect, it, vi } from "vitest";

import { capsFor } from "../src/main/chrome";
import { initialUpdate, newlyReady, notifyReady, PROGRESS_EVERY_MS, reduceUpdate, restartAction, UpdateTracker, type PageNow } from "../src/main/updateState";
import type { HostUpdate } from "../src/shared/desktopHost.generated";

const T = 1_700_000_000_000;

/** Feed electron-updater's events in order, one second apart; every state on the way. */
function run(events: [string, unknown?][], from: HostUpdate = initialUpdate("0.1.3")): HostUpdate[] {
  const out: HostUpdate[] = [];
  let s = from;
  events.forEach(([name, info], i) => {
    s = reduceUpdate(s, name, info, T + i * 1000);
    out.push(s);
  });
  return out;
}
const last = (events: [string, unknown?][], from?: HostUpdate) => run(events, from).at(-1)!;

const READY: [string, unknown?][] = [
  ["checking-for-update"],
  ["update-available", { version: "0.1.4" }],
  ["download-progress", { percent: 12.7 }],
  ["update-downloaded", { version: "0.1.4" }],
];

describe("the shell's update, as the page hears it", () => {
  it("is offered on every OS the shell ships for", () => {
    for (const os of ["macos", "windows", "linux"] as const) expect(capsFor(os)).toContain("update");
  });

  it("starts idle", () => {
    expect(initialUpdate("0.1.3")).toEqual({ current: "0.1.3", phase: "idle" });
  });

  it("follows a check through the download to ready", () => {
    expect(run([...READY.slice(0, 3), ["download-progress", { percent: 50 }], READY[3]])).toEqual([
      { current: "0.1.3", phase: "checking" },
      { current: "0.1.3", phase: "downloading", next: "0.1.4", percent: 0, checkedAt: T + 1000 },
      { current: "0.1.3", phase: "downloading", next: "0.1.4", percent: 12, checkedAt: T + 1000 },
      { current: "0.1.3", phase: "downloading", next: "0.1.4", percent: 50, checkedAt: T + 1000 },
      { current: "0.1.3", phase: "ready", next: "0.1.4", checkedAt: T + 1000 },
    ]);
  });

  it("an answered check with nothing new is idle, and says when", () => {
    expect(last([["checking-for-update"], ["update-not-available", { version: "0.1.3" }]])).toEqual({
      current: "0.1.3",
      phase: "idle",
      checkedAt: T + 1000,
    });
  });

  it("ready stays ready through every later check — the same version again is no news", () => {
    const ready = last(READY);
    for (const [name, info] of [
      ["checking-for-update"],
      ["update-available", { version: "0.1.4" }],
      ["update-available", { version: "0.1.5" }],
      ["download-progress", { percent: 40 }],
      ["update-not-available", { version: "0.1.4" }],
      ["update-cancelled", { version: "0.1.5" }],
      ["error", new Error("net::ERR_INTERNET_DISCONNECTED")],
      ["update-downloaded", { version: "0.1.4" }],
    ] as [string, unknown?][]) {
      // The same object: nothing to tell anyone (no event, no redraw, no second notice).
      expect(reduceUpdate(ready, name, info, T + 99_000), name).toBe(ready);
    }
  });

  it("a different version downloaded after ready replaces it — that is the one a restart installs", () => {
    const ready = last(READY);
    expect(reduceUpdate(ready, "update-downloaded", { version: "0.1.5" }, T + 99_000)).toEqual({
      current: "0.1.3",
      phase: "ready",
      next: "0.1.5",
      checkedAt: T + 1000,
    });
  });

  it("an error is not the end: the next check can still get to ready", () => {
    const states = run([["checking-for-update"], ["error", new Error("ENOTFOUND")], ...READY]);
    expect(states[1]).toEqual({ current: "0.1.3", phase: "error" });
    expect(states.at(-1)).toMatchObject({ phase: "ready", next: "0.1.4" });
  });

  it("a check while downloading does not restart the bar", () => {
    const at40 = last([...READY.slice(0, 2), ["download-progress", { percent: 40.2 }]]);
    expect(reduceUpdate(at40, "checking-for-update", undefined, T + 9000)).toBe(at40);
    expect(reduceUpdate(at40, "update-available", { version: "0.1.4" }, T + 9000)).toBe(at40);
    // A cancelled download is back to nothing on its way.
    expect(reduceUpdate(at40, "update-cancelled", { version: "0.1.4" }, T + 9000)).toEqual({ current: "0.1.3", phase: "idle", checkedAt: T + 1000 });
  });

  it("the same whole percent twice is no news", () => {
    const at12 = last(READY.slice(0, 3));
    expect(reduceUpdate(at12, "download-progress", { percent: 12.9 }, T + 9000)).toBe(at12);
  });

  it("keeps what it does not understand out", () => {
    const s = initialUpdate("0.1.3");
    expect(reduceUpdate(s, "quit-and-install", {}, T)).toBe(s);
    expect(reduceUpdate(s, "update-downloaded", {}, T)).toBe(s);
    expect(reduceUpdate(s, "update-downloaded", { version: 7 }, T)).toBe(s);
    expect(reduceUpdate(s, "update-available", { version: "x".repeat(200) }, T)).toBe(s);
    expect(reduceUpdate(s, "download-progress", { percent: Number.NaN }, T)).toBe(s);
    expect(reduceUpdate(s, "download-progress", null, T)).toBe(s);
    // Out of range is clamped, not trusted.
    expect(reduceUpdate(s, "download-progress", { percent: 250 }, T)).toEqual({ current: "0.1.3", phase: "downloading", percent: 100 });
  });
});

describe("telling the page", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends every change at once, and nothing for no news", () => {
    vi.useFakeTimers({ now: T });
    const sent: HostUpdate[] = [];
    const t = new UpdateTracker("0.1.3", (u) => sent.push(u));
    expect(t.state).toEqual({ current: "0.1.3", phase: "idle" });
    for (const [name, info] of READY) t.feed(name, info);
    // All in the same instant: the progress waited its turn and ready overtook it.
    expect(sent.map((u) => u.phase)).toEqual(["checking", "downloading", "ready"]);
    expect(t.feed("update-downloaded", { version: "0.1.4" })).toBe(false);
    expect(t.feed("checking-for-update")).toBe(false);
    vi.advanceTimersByTime(PROGRESS_EVERY_MS * 2);
    expect(sent).toHaveLength(3);
    expect(t.state).toMatchObject({ phase: "ready", next: "0.1.4" });
  });

  it("download progress at most every half second — and the latest one still arrives", () => {
    vi.useFakeTimers({ now: T });
    const sent: HostUpdate[] = [];
    const t = new UpdateTracker("0.1.3", (u) => sent.push(u));
    t.feed("update-available", { version: "0.1.4" });
    for (let p = 1; p <= 30; p++) {
      vi.advanceTimersByTime(20); // electron-updater reports far more often than this
      t.feed("download-progress", { percent: p });
    }
    // 600 ms of progress, 30 reports: one went out when the half second since
    // "available" was up (24 by then), the newest of the rest waits for the next.
    expect(sent.map((u) => u.percent)).toEqual([0, 24]);
    vi.advanceTimersByTime(PROGRESS_EVERY_MS);
    expect(sent.map((u) => u.percent)).toEqual([0, 24, 30]);
    vi.advanceTimersByTime(PROGRESS_EVERY_MS * 4);
    expect(sent).toHaveLength(3);
  });

  it("ready goes out at once, and a progress still waiting is dropped behind it", () => {
    vi.useFakeTimers({ now: T });
    const sent: HostUpdate[] = [];
    const t = new UpdateTracker("0.1.3", (u) => sent.push(u));
    t.feed("update-available", { version: "0.1.4" });
    vi.advanceTimersByTime(100);
    t.feed("download-progress", { percent: 99 });
    t.feed("update-downloaded", { version: "0.1.4" });
    expect(sent.map((u) => u.phase)).toEqual(["downloading", "ready"]);
    vi.advanceTimersByTime(PROGRESS_EVERY_MS * 2);
    expect(sent.map((u) => u.phase)).toEqual(["downloading", "ready"]);
  });
});

describe("the restart outside the page: the tray, the menu, the notification", () => {
  // Every page there can be: listening to `update` or not (an older page, the
  // offline page, one still loading, the pill switched off), its window in
  // front or not (in the tray, minimised, behind another app's window), on its
  // way out to another document or staying, answering or not.
  const bools = [true, false];
  const pages: PageNow[] = bools.flatMap((listening) =>
    bools.flatMap((inFront) => bools.flatMap((leaving) => bools.map((hung) => ({ listening, inFront, leaving, hung })))),
  );
  const row = (p: PageNow) =>
    [p.listening ? "listening" : "deaf", p.inFront ? "in front" : "not in front", p.leaving ? "leaving" : "staying", p.hung ? "hung" : "answering"].join(", ");
  // A page that listens, stays and answers takes the restart; any other is
  // restarted at once, as before the page drew one.
  const takes = (p: PageNow) => p.listening && !p.leaving && !p.hung;

  it("a version ready is the system's notification only when a page that offers it is in front of the person", () => {
    const table = Object.fromEntries(pages.map((p) => [row(p), notifyReady(p)]));
    expect(table).toEqual({
      "listening, in front, leaving, hung": true,
      "listening, in front, leaving, answering": true, // the page that would say it is going
      "listening, in front, staying, hung": true,
      "listening, in front, staying, answering": false, // the pill says it
      "listening, not in front, leaving, hung": true,
      "listening, not in front, leaving, answering": true,
      "listening, not in front, staying, hung": true,
      "listening, not in front, staying, answering": true, // in the tray, or behind another app: nobody sees the pill
      "deaf, in front, leaving, hung": true,
      "deaf, in front, leaving, answering": true,
      "deaf, in front, staying, hung": true,
      "deaf, in front, staying, answering": true,
      "deaf, not in front, leaving, hung": true,
      "deaf, not in front, leaving, answering": true,
      "deaf, not in front, staying, hung": true,
      "deaf, not in front, staying, answering": true,
    });
  });

  it("the tray's and the menu's Restart to Update asks a page that listens, stays and answers; any other restarts at once", () => {
    for (const p of pages) expect(restartAction(p, "menu"), row(p)).toBe(takes(p) ? "ask" : "install");
  });

  it("a page on its way out cannot take it: an ask sent now would leave with it, so the restart happens at once", () => {
    const leaving: PageNow = { listening: true, inFront: true, leaving: true, hung: false };
    expect(restartAction(leaving, "menu")).toBe("install");
    expect(restartAction(leaving, "notice")).toBe("install");
    expect(restartAction({ ...leaving, leaving: false }, "menu")).toBe("ask"); // the same page, staying
  });

  it("the notification, clicked, only brings such a page forward — its pill offers the restart; any other restarts at once", () => {
    for (const p of pages) expect(restartAction(p, "notice"), row(p)).toBe(takes(p) ? "show" : "install");
  });

  it("is announced once per version: when it becomes ready, and again only for a different one", () => {
    const states = run(READY);
    const news = states.map((s, i) => newlyReady(i ? states[i - 1] : initialUpdate("0.1.3"), s));
    expect(news).toEqual([null, null, null, "0.1.4"]);
    const ready = states.at(-1)!;
    // The four-hourly check finds the same file again: no news, no second notification.
    expect(newlyReady(ready, reduceUpdate(ready, "update-downloaded", { version: "0.1.4" }, T + 99_000))).toBeNull();
    expect(newlyReady(ready, reduceUpdate(ready, "update-downloaded", { version: "0.1.5" }, T + 99_000))).toBe("0.1.5");
  });
});
