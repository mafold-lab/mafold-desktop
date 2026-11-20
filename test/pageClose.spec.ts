import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closePage, PAGE_CLOSE_GRACE_MS, type ClosablePage } from "../src/main/pageClose";

/** A page's web contents, as far as closing it goes: `close({waitForBeforeUnload})`
 *  runs the page's beforeunload (`onBeforeUnload`), which either lets it go —
 *  destroyed — or asks to stay (`will-prevent-unload`, which Electron lets go of
 *  when a listener prevents it), or never answers. */
function fakePage(onBeforeUnload: "go" | "stay" | "hang") {
  const ee = new EventEmitter();
  let destroyed = false;
  const closes: Array<{ waitForBeforeUnload?: boolean } | undefined> = [];
  const destroy = () => {
    destroyed = true;
    ee.emit("destroyed");
  };
  const page = {
    isDestroyed: () => destroyed,
    once: (n: string, f: (...a: unknown[]) => void) => (ee.once(n, f), page),
    on: (n: string, f: (...a: unknown[]) => void) => (ee.on(n, f), page),
    off: (n: string, f: (...a: unknown[]) => void) => (ee.off(n, f), page),
    close: (opts?: { waitForBeforeUnload?: boolean }) => {
      closes.push(opts);
      if (!opts?.waitForBeforeUnload) return destroy();
      if (onBeforeUnload === "go") queueMicrotask(destroy);
      if (onBeforeUnload === "stay") {
        let prevented = false;
        ee.emit("will-prevent-unload", { preventDefault: () => (prevented = true) });
        if (prevented) queueMicrotask(destroy);
      }
    },
  };
  return { page: page as unknown as ClosablePage, closes, listeners: () => ee.eventNames() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("closePage (a quit gives the page its beforeunload first)", () => {
  it("runs the page's beforeunload and settles once the page is gone", async () => {
    const f = fakePage("go");
    await closePage(f.page);
    expect(f.closes).toEqual([{ waitForBeforeUnload: true }]);
    expect(f.page.isDestroyed()).toBe(true);
    // Nothing left listening on a page that is gone.
    expect(f.listeners()).toEqual([]);
  });

  it("a page asking to stay does not keep the quit", async () => {
    const f = fakePage("stay");
    await closePage(f.page);
    expect(f.page.isDestroyed()).toBe(true);
    expect(f.closes).toEqual([{ waitForBeforeUnload: true }]);
  });

  it("a page that never answers is closed outright after the grace", async () => {
    vi.useFakeTimers();
    const f = fakePage("hang");
    let settled = false;
    const p = closePage(f.page).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(PAGE_CLOSE_GRACE_MS - 1);
    expect(settled).toBe(false);
    expect(f.page.isDestroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(f.closes).toEqual([{ waitForBeforeUnload: true }, undefined]);
    expect(f.page.isDestroyed()).toBe(true);
    expect(f.listeners()).toEqual([]);
  });

  it("a page already gone settles at once, without closing anything", async () => {
    const f = fakePage("go");
    f.page.close();
    f.closes.length = 0;
    await closePage(f.page);
    expect(f.closes).toEqual([]);
  });
});
