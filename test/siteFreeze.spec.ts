// siteFreeze.ts without Electron: the scripts run against a stand-in document,
// and the tab is a stand-in contents that writes down what was done to it —
// muted, paused in which frames, its scripts paused through which debugger,
// and back. That
// the page really stops (and plays again) in a real shell is e2e/siteFreeze.spec.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Shell } from "../src/main/shell";

const h = vi.hoisted(() => ({ tabs: new Map<number, unknown>(), others: [] as unknown[] }));

vi.mock("electron", () => ({
  webContents: { getAllWebContents: () => [...h.tabs.values(), ...h.others] },
}));
vi.mock("../src/main/sites", () => ({
  pageSite: (_shell: unknown, tab: number) => h.tabs.get(tab) ?? null,
  unsealed: (c: { isolated: unknown }) => ({ executeJavaScriptInIsolatedWorld: c.isolated }),
}));
vi.mock("../src/main/log", () => ({ log: () => {} }));

import { PAUSE_SCRIPT, RESUME_SCRIPT, SiteFreezes } from "../src/main/siteFreeze";

// ── the scripts ─────────────────────────────────────────────────────────────

class Media {
  plays = 0;
  pauses = 0;
  isConnected = true;
  shadowRoot: Root | null = null;
  constructor(
    public paused: boolean,
    public ended = false,
  ) {}
  pause() {
    this.pauses += 1;
    this.paused = true;
  }
  play() {
    this.plays += 1;
    this.paused = false;
    return Promise.resolve();
  }
}
class Box {
  constructor(public shadowRoot: Root | null = null) {}
}
class Root {
  constructor(private all: Array<Media | Box>) {}
  querySelectorAll(sel: string) {
    if (sel !== "*") throw new Error(`unexpected selector ${sel}`);
    return this.all;
  }
}

const runIn = (script: string, win: Record<PropertyKey, unknown>, doc: Root) =>
  new Function("window", "document", "HTMLMediaElement", `return ${script}`)(win, doc, Media) as { paused?: number; played?: number };

describe("the scripts", () => {
  it("pause only what plays, shadow roots included, and play again only that", () => {
    const playing = new Media(false);
    const stopped = new Media(true);
    const over = new Media(false, true);
    const inShadow = new Media(false);
    const doc = new Root([playing, stopped, over, new Box(new Root([inShadow]))]);
    const win: Record<PropertyKey, unknown> = {};

    expect(runIn(PAUSE_SCRIPT, win, doc)).toEqual({ paused: 2 });
    expect([playing.paused, inShadow.paused, stopped.pauses, over.pauses]).toEqual([true, true, 0, 0]);
    // Asked again while still: nothing new, nothing lost.
    expect(runIn(PAUSE_SCRIPT, win, doc).paused).toBe(2);

    expect(runIn(RESUME_SCRIPT, win, doc)).toEqual({ played: 2 });
    expect([playing.paused, inShadow.paused, stopped.paused, over.plays]).toEqual([false, false, true, 0]);
    expect(runIn(RESUME_SCRIPT, win, doc).played).toBe(0);
  });

  it("a document that was never paused has nothing to play", () => {
    const m = new Media(true);
    expect(runIn(RESUME_SCRIPT, {}, new Root([m]))).toEqual({ played: 0 });
    expect(m.plays).toBe(0);
  });
});

// ── the tab ─────────────────────────────────────────────────────────────────

interface Opts {
  muted?: boolean;
  /** Someone else's debugger is on the tab already. */
  attached?: boolean;
  /** attach() throws, as when another client holds the tab. */
  refuse?: boolean;
  /** Its renderer's process. */
  pid?: number;
  /** `Debugger.resume` fails: no script had run since the pause was asked. */
  neverPaused?: boolean;
}

function site(id: number, o: Opts = {}) {
  const did: string[] = [];
  let muted = o.muted ?? false;
  let attached = o.attached ?? false;
  const gone: Array<() => void> = [];
  const detachListeners: Array<() => void> = [];
  const script = (code: string) => (code === PAUSE_SCRIPT ? "pause" : code === RESUME_SCRIPT ? "resume" : "?");
  const sub = {
    detached: false,
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async (code: string, gesture: boolean) => {
      did.push(`sub ${script(code)}${gesture ? " gesture" : ""}`);
    }),
  };
  const top = { detached: false, isDestroyed: () => false, framesInSubtree: [] as unknown[] };
  const c = {
    did,
    destroyed: false,
    isDestroyed: () => c.destroyed,
    isAudioMuted: () => muted,
    setAudioMuted: (m: boolean) => {
      did.push(m ? "mute" : "unmute");
      muted = m;
    },
    once: (ev: string, fn: () => void) => {
      if (ev === "destroyed") gone.push(fn);
    },
    destroy: () => {
      c.destroyed = true;
      for (const fn of gone) fn();
    },
    mainFrame: top,
    isolated: vi.fn(async (_world: number, scripts: Array<{ code: string }>, gesture: boolean) => {
      did.push(`top ${script(scripts[0].code)}${gesture ? " gesture" : ""}`);
      return { paused: 0 };
    }),
    getOSProcessId: () => o.pid ?? 100 + id,
    debugger: {
      isAttached: () => attached,
      attach: (v: string) => {
        if (o.refuse) throw new Error("Another debugger is already attached");
        did.push(`attach ${v}`);
        attached = true;
      },
      detach: () => {
        did.push("detach");
        attached = false;
      },
      /** DevTools opened on the tab: the debugger is taken away. */
      takeAway: () => {
        attached = false;
        for (const fn of detachListeners.splice(0)) fn();
      },
      once: (ev: string, fn: () => void) => {
        if (ev === "detach") detachListeners.push(fn);
      },
      sendCommand: vi.fn(async (method: string) => {
        if (method === "Debugger.resume" && o.neverPaused) throw new Error("Can only perform operation while paused.");
        did.push(method);
      }),
    },
  };
  top.framesInSubtree = [top, sub];
  h.tabs.set(id, c);
  return c;
}

const shell = {} as Shell;

beforeEach(() => {
  h.tabs.clear();
  h.others.length = 0;
});

describe("a site tab going still, and back", () => {
  it("mutes, pauses in every frame, pauses its scripts; then the reverse", async () => {
    const c = site(7);
    const f = new SiteFreezes(shell);
    expect(await f.set(7, true)).toBe(true);
    expect(c.did).toEqual(["mute", "top pause", "sub pause", "attach 1.3", "Debugger.enable", "Debugger.pause"]);
    expect(f.isStill(c as never)).toBe(true);

    c.did.length = 0;
    expect(await f.set(7, false)).toBe(true);
    expect(c.did).toEqual(["Debugger.resume", "Debugger.disable", "detach", "top resume gesture", "sub resume gesture", "unmute"]);
    expect(f.isStill(c as never)).toBe(false);
  });

  it("a tab muted before stays muted", async () => {
    const c = site(7, { muted: true });
    const f = new SiteFreezes(shell);
    await f.set(7, true);
    await f.set(7, false);
    expect(c.did).not.toContain("unmute");
    expect(c.isAudioMuted()).toBe(true);
  });

  it("asking twice is asking once, and back from nothing is a yes", async () => {
    const c = site(7);
    const f = new SiteFreezes(shell);
    expect(await f.set(7, false)).toBe(true);
    expect(c.did).toEqual([]);
    const [a, b] = await Promise.all([f.set(7, true), f.set(7, true)]);
    expect([a, b]).toEqual([true, true]);
    expect(c.did.filter((d) => d === "Debugger.pause")).toHaveLength(1);
    await Promise.all([f.set(7, false), f.set(7, false)]);
    expect(c.did.filter((d) => d === "Debugger.resume")).toHaveLength(1);
    expect(c.did.filter((d) => d === "unmute")).toHaveLength(1);
  });

  it("changes go in the order asked", async () => {
    const c = site(7);
    const f = new SiteFreezes(shell);
    const all = await Promise.all([f.set(7, true), f.set(7, false), f.set(7, true)]);
    expect(all).toEqual([true, true, true]);
    expect(c.did.filter((d) => d === "Debugger.pause" || d === "Debugger.resume")).toEqual(["Debugger.pause", "Debugger.resume", "Debugger.pause"]);
    expect(f.isStill(c as never)).toBe(true);
  });

  it("a debugger it can't have: still paused and muted, and a yes", async () => {
    const c = site(7, { refuse: true });
    const f = new SiteFreezes(shell);
    expect(await f.set(7, true)).toBe(true);
    expect(c.did).toEqual(["mute", "top pause", "sub pause"]);
    expect(await f.set(7, false)).toBe(true);
    expect(c.did.slice(3)).toEqual(["top resume gesture", "sub resume gesture", "unmute"]);
  });

  it("a debugger already on the tab is used and left on", async () => {
    const c = site(7, { attached: true });
    const f = new SiteFreezes(shell);
    await f.set(7, true);
    await f.set(7, false);
    expect(c.did.some((d) => d.startsWith("attach") || d === "detach")).toBe(false);
    expect(c.did.filter((d) => d.startsWith("Debugger."))).toEqual(["Debugger.enable", "Debugger.pause", "Debugger.resume", "Debugger.disable"]);
    expect(c.debugger.isAttached()).toBe(true);
  });

  it("a debugger taken away while still (it resumed the page as it went): not asked again", async () => {
    const c = site(7);
    const f = new SiteFreezes(shell);
    await f.set(7, true);
    c.debugger.takeAway();
    c.did.length = 0;
    expect(await f.set(7, false)).toBe(true);
    expect(c.did).toEqual(["top resume gesture", "sub resume gesture", "unmute"]);
  });

  it("put away and back before any script ran: the page was never paused, and comes back all the same", async () => {
    const c = site(7, { neverPaused: true });
    const f = new SiteFreezes(shell);
    await f.set(7, true);
    c.did.length = 0;
    expect(await f.set(7, false)).toBe(true);
    expect(c.did).toEqual(["Debugger.disable", "detach", "top resume gesture", "sub resume gesture", "unmute"]);
  });

  it("a renderer it shares with another page: paused and muted, its scripts left running", async () => {
    const c = site(7, { pid: 42 });
    h.others.push({ isDestroyed: () => false, getOSProcessId: () => 42 });
    const f = new SiteFreezes(shell);
    expect(await f.set(7, true)).toBe(true);
    expect(c.did).toEqual(["mute", "top pause", "sub pause"]);
    expect(await f.set(7, false)).toBe(true);
    expect(c.did.slice(3)).toEqual(["top resume gesture", "sub resume gesture", "unmute"]);
  });

  it("not a site of the page: no", async () => {
    const c = site(7);
    const f = new SiteFreezes(shell);
    expect(await f.set(8, true)).toBe(false);
    expect(await f.set(8, false)).toBe(false);
    expect(c.did).toEqual([]);
  });

  it("a tab that goes: no, and nothing kept", async () => {
    const c = site(7);
    c.isolated.mockImplementationOnce(async () => {
      c.destroy();
      return { paused: 0 };
    });
    const f = new SiteFreezes(shell);
    expect(await f.set(7, true)).toBe(false);
    expect(f.isStill(c as never)).toBe(false);
    expect(c.debugger.sendCommand).not.toHaveBeenCalled();
    expect(await f.set(7, false)).toBe(false);
  });

  it("gone while still: forgotten", async () => {
    const c = site(7);
    const f = new SiteFreezes(shell);
    await f.set(7, true);
    c.destroy();
    expect(f.isStill(c as never)).toBe(false);
    expect(await f.set(7, false)).toBe(false);
  });

});
