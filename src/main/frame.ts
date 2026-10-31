// The main window's frame: where the page sits in it. On Windows and Linux
// the page fills the window's content area, under the system's frame. On
// macOS, in the phone layout (chrome.ts), the shell draws a title bar of its
// own — the system's lights and the window's title, as tall as the system's
// bar — and the page sits BELOW it, in a window a bar shorter, so no screen of
// the page has to make room for anything. In the wide layout there is no bar:
// the page runs to the top edge and draws the lights at the head of its chat
// list, as before.
//
// The window has no system title bar to switch on and off (Electron sets that
// once, when it makes the window), so the shell lays the window out itself.
// That is why the window is a BaseWindow and the page a view in it (window.ts):
// a BrowserWindow's own page always fills the window, whatever its view's
// bounds say (CI, 10-30: the bar drew over the page's head).
//
// Which layout: the page says (`setWindowLayout`) — its breakpoint is in CSS
// px, which page zoom moves away from the window's width. A page that says it
// lowers the window's minimum to a phone's (windowState.ts); a page that draws
// its lights without having said — a web older than the bar — gets the wide
// frame and the 1024 minimum back. Until a new document says, the frame stays
// as it is: a reload does not jump.
//
// The bar is a static picture, like the loading cover (cover.ts): no script,
// no preload, a data: document that goes nowhere. It is a drag region, so
// dragging it moves the window and double-clicking it does what the system's
// title bar does (System Settings ▸ Desktop & Dock); the lights are the
// system's own, moved into it. Its title follows the window's ("(3) Mafold").

import { nativeTheme, WebContentsView, type BaseWindow, type Rectangle, type View } from "electron";

import { framePlan, TITLE_BAR, type Point } from "./chrome";
import { log } from "./log";
import { MAC_MIN_SIZE, MIN_SIZE } from "./windowState";
import type { WindowLayout } from "../shared/desktopHost.generated";

/** The system's own title bar on macOS 26, as the window shots measured it
 *  (#1326): the bar, the line under it, the title. */
const LOOK = {
  light: { bar: "#FFFFFF", line: "#E6E6E6", title: "#595959" },
  dark: { bar: "#1E1E1E", line: "#232323", title: "#9A9A9A" },
} as const;

/** The title starts where the system's does: after the lights, 85pt in. */
const TITLE_LEFT = 85;

/** The window changes size with these; the frame is laid out again. */
const RESIZED = ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const;

/** A CSS string for the title (`content:`): quotes and backslashes escaped,
 *  nothing that ends the declaration. */
const cssString = (s: string) => `"${s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const barDocument = (title: string) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
      `<style>` +
      `:root{color-scheme:light dark;--t:${cssString(title)}}` +
      `html,body{margin:0;height:100%;overflow:hidden;cursor:default;-webkit-user-select:none;user-select:none}` +
      `body{-webkit-app-region:drag;box-sizing:border-box;background:${LOOK.light.bar};box-shadow:inset 0 -1px ${LOOK.light.line};` +
      `padding-left:${TITLE_LEFT}px;font:700 13px/${TITLE_BAR.height - 1}px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:${LOOK.light.title};white-space:nowrap}` +
      `body::before{content:var(--t)}` +
      `@media (prefers-color-scheme:dark){body{background:${LOOK.dark.bar};box-shadow:inset 0 -1px ${LOOK.dark.line};color:${LOOK.dark.title}}}` +
      `</style></head><body></body></html>`,
  );

export class WindowFrame {
  private readonly root: View;
  private bar: WebContentsView | null = null;
  /** The bar is in the window now (not just made: out of it, it is nowhere —
   *  a hidden view could still count as somewhere to drag the window from). */
  private barIn = false;
  private layout: WindowLayout;
  /** The page in the window now has said which layout it is in. */
  private announced = false;
  /** The minimum is a phone's: a page said it knows the bar. */
  private narrow: boolean;
  private lights: Point | null = null;
  private titleCss: string | null = null;
  /** The window's title as the bar last heard it. */
  private title = "Mafold";
  private readonly followers = new Set<() => void>();

  /** `bars`: this shell draws the phone layout's title bar (macOS, the cap
   *  `window-titlebar`); without it the page always fills the window.
   *  `narrow`: the window may already go down to a phone's width (windowState.ts). */
  constructor(
    private readonly win: BaseWindow,
    private readonly page: WebContentsView,
    private readonly bars: boolean,
    narrow: boolean,
  ) {
    this.root = win.contentView;
    // What shows in a gap while the window is being resized: the page's own ground.
    this.root.setBackgroundColor(win.getBackgroundColor());
    this.root.addChildView(page);
    this.narrow = narrow;
    // Until the page says, the window's width guesses: a narrow window was left
    // in the phone layout.
    this.layout = bars && win.getContentSize()[0] < MAC_MIN_SIZE.width ? "phone" : "wide";
    for (const ev of RESIZED) win.on(ev as "resize", this.apply);
    // The content area can change with no resize: Windows' menu bar, hidden
    // until Alt, takes its height from it.
    this.root.on("bounds-changed", this.apply);
    this.apply();
  }

  /** Where the page is in the window, for the loading cover over it. */
  pageBounds(): Rectangle {
    return this.page.getBounds();
  }

  /** `fn` after every layout (the cover follows the page). */
  follow(fn: () => void): () => void {
    this.followers.add(fn);
    return () => this.followers.delete(fn);
  }

  /** The bar is up now. */
  get shown(): boolean {
    return this.barIn;
  }

  /** A new document: it has not said anything yet. The frame stays. */
  newDocument(): void {
    this.announced = false;
  }

  /** The page says which layout it is in: the frame follows, and the window
   *  may go down to a phone's width. */
  setLayout(layout: WindowLayout): void {
    if (!this.bars) return;
    this.announced = true;
    if (!this.narrow) {
      this.narrow = true;
      this.win.setMinimumSize(MIN_SIZE.width, MIN_SIZE.height);
    }
    if (layout === this.layout) return;
    this.layout = layout;
    this.apply();
  }

  /** The page draws (true) / no longer draws its lights (bridge.ts). Drawing
   *  them without having said its layout is a page that draws them at every
   *  width: no bar for it, and the window back to the width they need. */
  pageDrawsLights(drawn: boolean): void {
    if (!this.bars || !drawn || this.announced) return;
    if (this.narrow) {
      this.narrow = false;
      log("the page draws its lights without the title bar: the window goes back to", MAC_MIN_SIZE.width);
      this.win.setMinimumSize(MAC_MIN_SIZE.width, MAC_MIN_SIZE.height);
      const [w, h] = this.win.getSize();
      if (w < MAC_MIN_SIZE.width || h < MAC_MIN_SIZE.height) this.win.setSize(Math.max(w, MAC_MIN_SIZE.width), Math.max(h, MAC_MIN_SIZE.height));
    }
    if (this.layout === "wide") return;
    this.layout = "wide";
    this.apply();
  }

  /** Light or dark changed (window.ts, after the window's own ground): the
   *  root under the views, and the bar before its document repaints. */
  reground(ground: string): void {
    this.root.setBackgroundColor(ground);
    this.bar?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? LOOK.dark.bar : LOOK.light.bar);
  }

  private apply = () => {
    const win = this.win;
    if (win.isDestroyed()) return;
    const fullscreen = win.isFullScreen();
    const b = this.root.getBounds();
    const [width, height] = b.width > 0 && b.height > 0 ? [b.width, b.height] : win.getContentSize();
    const plan = framePlan({ layout: this.layout, fullscreen }, { width, height });
    this.page.setBounds(plan.page);
    if (plan.bar) {
      const bar = this.bar ?? this.makeBar();
      bar.setBounds({ x: 0, y: 0, width, height: TITLE_BAR.height });
      // Above the page, under the loading cover if that is still up (it covers
      // the page's part only, cover.ts): added right after the page.
      if (!this.barIn) this.root.addChildView(bar, 1);
      this.barIn = true;
    } else if (this.bar && this.barIn) {
      this.root.removeChildView(this.bar);
      this.barIn = false;
    }
    // Full screen has the system's own bar (on hover), lights and all.
    if (this.bars && !fullscreen && (this.lights?.x !== plan.lights.x || this.lights?.y !== plan.lights.y)) {
      this.lights = plan.lights;
      win.setWindowButtonPosition(plan.lights);
    }
    for (const fn of this.followers) fn();
  };

  private makeBar(): WebContentsView {
    const bar = new WebContentsView({
      webPreferences: {
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const wc = bar.webContents;
    bar.setBackgroundColor(nativeTheme.shouldUseDarkColors ? LOOK.dark.bar : LOOK.light.bar);
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    // A click on it never keeps the keyboard: that stays the page's.
    wc.on("focus", () => {
      if (!this.page.webContents.isDestroyed()) this.page.webContents.focus();
    });
    this.win.once("closed", () => {
      if (!wc.isDestroyed()) wc.close();
    });
    this.bar = bar;
    this.titleCss = null;
    this.title = this.win.getTitle();
    // A title that changed while the document was on its way goes on once it is there.
    wc.on("did-finish-load", () => this.retitle(this.title));
    void wc.loadURL(barDocument(this.title)).catch((err: unknown) => log("title bar failed to load:", String(err)));
    return bar;
  }

  /** The window's title changed (window.ts): the bar's follows (no script in it — a style). */
  retitle(title: string): void {
    this.title = title;
    const wc = this.bar?.webContents;
    if (!wc || wc.isDestroyed() || wc.isLoading()) return;
    const before = this.titleCss;
    void wc
      .insertCSS(`:root{--t:${cssString(title)} !important}`)
      .then((key) => {
        this.titleCss = key;
        if (before) void wc.removeInsertedCSS(before);
      })
      .catch(() => {});
  }
}
