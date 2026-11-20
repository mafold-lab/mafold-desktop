// A site tab put away goes still (cap `site-freeze`): the page minimizes its
// page of tabs and says so for each site on it (mafold-web), and a video left
// playing there stops — no sound, no timers, no scripts — until the page
// brings the tabs back. The page can't do this to a site by itself (its tag's
// methods are sealed, sites.ts), and a card runs in the page's realm, so the
// tab is checked the same way an agent's is: a site on the main window's page.
//
// Going still is three things, each of which holds without the others:
//   - what plays is paused, in every frame the shell reaches, and remembered,
//     so coming back plays again only what was playing;
//   - the tab is muted (a tab muted before stays muted after);
//   - its scripts are paused through the DevTools protocol (`Debugger.pause`):
//     no timers, no scripts, until `Debugger.resume`. Chromium's own freeze
//     (`Page.setWebLifecycleState`) answers yes on a <webview> and does
//     nothing there — the site's timers ran on at 50 ms, with no freeze or
//     visibilitychange (#1703's e2e). A paused script holds every page of its
//     renderer, so a tab that shares its process with any other contents is
//     only paused and muted. Nothing else in the shell drives a site's
//     `debugger`; a tab that can't have it (another client refused us) is
//     still paused and muted, and the answer is still yes.

import { webContents, type WebContents } from "electron";

import { log } from "./log";
import type { Shell } from "./shell";
import { pageSite, unsealed } from "./sites";

/** The scripts' world in the site's top frame: the site's own scripts can't
 *  see what was paused, or replace what pausing calls. (siteAgent.ts uses
 *  1999.) Frames below it are reached in the site's own world (`WebFrameMain`
 *  offers no other): there a site could only keep itself playing, muted. */
const WORLD = 1998;
/** How long one frame may take to answer: a hung renderer doesn't hold the
 *  page's call. */
const FRAME_MS = 1000;
const PROTOCOL = "1.3";

/** Where a frame keeps what it paused. */
const HELD = `Symbol.for("mafold.siteFreeze")`;

/** Pause what plays in this document (shadow roots included) and remember it. */
export const PAUSE_SCRIPT = `(() => {
  const held = window[${HELD}] || (window[${HELD}] = new Set());
  const each = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLMediaElement && !el.paused && !el.ended) {
        held.add(el);
        el.pause();
      }
      if (el.shadowRoot) each(el.shadowRoot);
    }
  };
  each(document);
  return { paused: held.size };
})()`;

/** Play again what PAUSE_SCRIPT paused and is paused still; forget it. */
export const RESUME_SCRIPT = `(() => {
  const held = window[${HELD}];
  let played = 0;
  if (held) {
    for (const el of held) {
      if (el.paused && el.isConnected) {
        played += 1;
        el.play().catch(() => {});
      }
    }
    held.clear();
  }
  return { played };
})()`;

interface Still {
  /** Muted before it went still: coming back leaves it muted. */
  wasMuted: boolean;
  /** Its scripts were paused through the protocol. */
  frozen: boolean;
  /** The debugger is attached by us, and is ours to detach. */
  ours: boolean;
}

/** Another contents in the tab's renderer: pausing its scripts would hold
 *  that one too. */
const sharesProcess = (c: WebContents): boolean => {
  const pid = c.getOSProcessId();
  return webContents.getAllWebContents().some((w) => w !== c && !w.isDestroyed() && w.getOSProcessId() === pid);
};

const within = <T>(p: Promise<T>): Promise<T | undefined> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), FRAME_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });

export class SiteFreezes {
  private still = new Map<WebContents, Still>();
  /** One change at a time per tab, in the order the page asked. */
  private queue = new Map<WebContents, Promise<boolean>>();
  private watched = new WeakSet<WebContents>();

  constructor(private shell: Shell) {}

  /** Whether the tab is still now (for tests and logs). */
  isStill(contents: WebContents): boolean {
    return this.still.has(contents);
  }

  /** `freezeSite(tab, frozen)`: false when `tab` isn't a site of the page, or
   *  it went before it was done. Asking twice is asking once. */
  set(tab: number, frozen: boolean): Promise<boolean> {
    const c = pageSite(this.shell, tab);
    if (!c) return Promise.resolve(false);
    const before = this.queue.get(c) ?? Promise.resolve(true);
    const next = before.then(() => (frozen ? this.freeze(c) : this.thaw(c))).catch((err: unknown) => {
      log("site freeze failed:", String(err));
      return false;
    });
    this.queue.set(c, next);
    void next.then(() => {
      if (this.queue.get(c) === next) this.queue.delete(c);
    });
    return next;
  }

  private watch(c: WebContents): void {
    if (this.watched.has(c)) return;
    this.watched.add(c);
    c.once("destroyed", () => {
      this.still.delete(c);
      this.queue.delete(c);
    });
  }

  private async freeze(c: WebContents): Promise<boolean> {
    if (c.isDestroyed()) return false;
    if (this.still.has(c)) return true;
    this.watch(c);
    const s: Still = { wasMuted: c.isAudioMuted(), frozen: false, ours: false };
    this.still.set(c, s);
    c.setAudioMuted(true);
    await this.inFrames(c, PAUSE_SCRIPT, false);
    if (c.isDestroyed()) return false;
    if (sharesProcess(c)) {
      log("site paused and muted, not frozen: its renderer holds another page");
      return true;
    }
    try {
      this.attach(c, s);
      await c.debugger.sendCommand("Debugger.enable");
      await c.debugger.sendCommand("Debugger.pause");
      s.frozen = true;
      log("site frozen");
    } catch (err) {
      log("site paused and muted, not frozen:", String(err));
      this.detach(c, s);
    }
    return !c.isDestroyed();
  }

  private async thaw(c: WebContents): Promise<boolean> {
    if (c.isDestroyed()) return false;
    const s = this.still.get(c);
    if (!s) return true;
    if (s.frozen) {
      // Running again first of all: nothing runs in a paused page, the
      // scripts below included. A debugger that went meanwhile (DevTools
      // opened on the tab takes it) resumed the page as it went.
      if (c.debugger.isAttached()) {
        try {
          await c.debugger.sendCommand("Debugger.resume");
        } catch (err) {
          // Not paused yet: no script had run since it was asked.
          log("site not resumed:", String(err));
        }
        try {
          await c.debugger.sendCommand("Debugger.disable");
        } catch (err) {
          log("site debugger not disabled:", String(err));
        }
      }
    }
    this.detach(c, s);
    this.still.delete(c);
    if (c.isDestroyed()) return false;
    await this.inFrames(c, RESUME_SCRIPT, true);
    if (c.isDestroyed()) return false;
    if (!s.wasMuted) c.setAudioMuted(false);
    return true;
  }

  private attach(c: WebContents, s: Still): void {
    const dbg = c.debugger;
    if (dbg.isAttached()) return;
    dbg.attach(PROTOCOL);
    s.ours = true;
    dbg.once("detach", () => {
      s.ours = false;
    });
  }

  private detach(c: WebContents, s: Still): void {
    if (!s.ours) return;
    s.ours = false;
    try {
      if (!c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
    } catch (err) {
      log("site debugger not detached:", String(err));
    }
  }

  /** `script` in every frame of the site. A frame that doesn't answer is
   *  passed over. */
  private async inFrames(c: WebContents, script: string, gesture: boolean): Promise<void> {
    let frames: Electron.WebFrameMain[];
    try {
      frames = c.mainFrame.framesInSubtree;
    } catch {
      return;
    }
    const real = unsealed(c);
    await Promise.all(
      frames.map(async (f) => {
        if (f === c.mainFrame) await within(real.executeJavaScriptInIsolatedWorld(WORLD, [{ code: script }], gesture));
        else if (!f.detached && !f.isDestroyed()) await within(f.executeJavaScript(script, gesture));
      }),
    );
  }
}
