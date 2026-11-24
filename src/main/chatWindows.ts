// A conversation in a window of its own, so several can stand side by side on a
// screen — the row dragged out of the list, or "Open in new window" on it.
//
// Each is a BrowserWindow with the web app again, like a second tab of a
// browser: same session, its own socket. It knows it is one by `soloChat`
// (`--mafold-solo-chat`, the preload) and draws that conversation, with its
// channels beside it, and no other. One channel can have a window of its own too
// (`--mafold-solo-channel`), so a conversation may stand in several at once.
// None of them takes anything from the main window, which can show the same
// conversation. What belongs to the app stays there, and it keeps running behind
// them, hidden or not: the badge, the tray, notifications, tabs of sites.
// `CHAT_WINDOW_CAPS` is what the page in one is told; bridge.ts answers no more.
// On macOS it has no title bar: the page draws the lights at the head of its
// list, as the main window's does (chrome.ts), and its ‹ hands the conversation
// back to the main window (`returnTo`). Its corners are the main window's
// (flag `windowCorners`, windowCorners.ts): cut to the same curve, see-through
// round it, none in full screen; it has no phone layout, so they never go.
//
// Unlike the main window, closing one closes it. The ones open when Mafold quits
// come back with it, where they were (chatWindowPlan.ts).

import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, screen, type Rectangle, type WebContents } from "electron";

import { cascadedBounds, CHAT_WINDOW_SIZE, CHAT_WINDOWS_FILE, chatWindowKey, CONV_WINDOW_SIZE, droppedBounds, readChatWindows, remembered, writeChatWindows, type ChatTarget, type SavedChatWindow } from "./chatWindowPlan";
import { FOLD_MS, ghost, GROW_MS, ROW_RADIUS, stillMotion, type Flight } from "./chatWindowFold";
import { capsFor, NATIVE_TRAFFIC_POSITION, type Point } from "./chrome";
import { attachContextMenu } from "./contextMenu";
import { log, redact } from "./log";
import { restoreZoom, zoomOnWheel } from "./pageZoom";
import { resourcePath } from "./paths";
import { relaunchUrl } from "./relaunch";
import { guardMainNavigation } from "./security";
import type { Shell } from "./shell";
import { offlinePage, offlineUrl, ground, pageWebPreferences } from "./window";
import { CLEAR, readWindowCorners, windowCut, type WindowCut } from "./windowCorners";
import { fit, MIN_SIZE, type Bounds } from "./windowState";
import { ALL_CHANNEL, CHAT_WINDOW_CAPS, IPC, WINDOW_CORNER, type PageRect } from "../shared/desktopHost.generated";

/** How long the main page has to say where a row is before the window just goes. */
const ASK_MS = 250;
/** How long a growing window waits for its page's first paint before it shows anyway. */
const PAINT_MS = 1500;
/** The window's corner in CSS: `WINDOW_CORNER` cut, under `corner-shape: squircle`;
 *  the system's own, uncut. */
const CUT_RADIUS = 55;
const SYSTEM_RADIUS = 10;

export class ChatWindows {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly file: string;
  private saved: SavedChatWindow[];
  /** On the way out: the windows closing now are to come back. */
  private staying = false;
  /** How round each is cut now (0: the system's), for the tests. */
  private readonly cornersOf = new Map<string, number>();
  /** The cut, loaded once: undefined until the first window asks. */
  private cutter: WindowCut | null | undefined;
  /** Folding into the main window: already given back to it. */
  private readonly gone = new Set<string>();
  private readonly returning = new Set<string>();
  /** The main page's answer to "where is this conversation's row?", awaited. */
  private readonly asked = new Map<string, (rect: PageRect | null) => void>();

  constructor(
    private readonly shell: Shell,
    private readonly os: "macos" | "windows" | "linux",
    userData: string,
  ) {
    this.file = join(userData, CHAT_WINDOWS_FILE);
    this.saved = readChatWindows(this.file);
    shell.onSubscribe((name) => {
      if (name === "chat-windows") this.tell();
    });
  }

  /** The main page hears which conversations are in windows of their own
   *  (`chat-window-fold`): not channels', not one already given back. */
  private tell(): void {
    this.shell.emit("chat-windows", this.ids().filter((k) => !k.includes("/") && !this.gone.has(k)).join(","));
  }

  /** A box in the main page, on the screen; null with no page to measure. */
  private onScreen(r: PageRect): Rectangle | null {
    const w = this.shell.window;
    const page = this.shell.page;
    const frame = this.shell.frame;
    if (!w || w.isDestroyed() || !page || page.isDestroyed() || !frame) return null;
    const c = w.getContentBounds();
    const p = frame.pageBounds();
    const z = page.getZoomFactor();
    return { x: c.x + p.x + r.x * z, y: c.y + p.y + r.y * z, width: r.width * z, height: r.height * z };
  }

  /** Where that conversation's row is on the screen, if the main page says. */
  private rowOf(conv: string): Promise<Rectangle | null> {
    if (!this.shell.isSubscribed("chat-window-fold")) return Promise.resolve(null);
    this.asked.get(conv)?.(null);
    return new Promise((resolve) => {
      const answer = (rect: PageRect | null) => {
        clearTimeout(timer);
        if (this.asked.get(conv) === answer) this.asked.delete(conv);
        resolve(rect ? this.onScreen(rect) : null);
      };
      const timer = setTimeout(() => answer(null), ASK_MS);
      this.asked.set(conv, answer);
      this.shell.emit("chat-window-fold", conv);
    });
  }

  /** The main page's answer to `chat-window-fold`. */
  foldTo(conv: string, rect: PageRect | null): void {
    this.asked.get(conv)?.(rect);
  }

  private flight(key: string, f: Pick<Flight, "from" | "to" | "kind">): Flight {
    const cut = (this.cornersOf.get(key) ?? 0) > 0;
    const windowRadius = cut ? CUT_RADIUS : SYSTEM_RADIUS;
    const fold = f.kind === "fold";
    return { ...f, ms: fold ? FOLD_MS : GROW_MS, fromRadius: fold ? windowRadius : ROW_RADIUS, toRadius: fold ? ROW_RADIUS : windowRadius, ground: ground(), squircle: cut };
  }

  ids(): string[] {
    return [...this.windows.keys()];
  }

  /** Each open one's corner, as `ids` lists them. */
  corners(): number[] {
    return this.ids().map((k) => this.cornersOf.get(k) ?? 0);
  }

  /** The main window's choice (window.ts), read as each is made: the flag
   *  reaches a new one at once, one that exists stays what it was made. */
  private cutFor(): WindowCut | null {
    if (this.os !== "macos" || !readWindowCorners(app.getPath("userData"))) return null;
    if (this.cutter === undefined) this.cutter = windowCut();
    return this.cutter;
  }

  /** The window a message in that channel belongs in, if one is open: the
   *  channel's own, or else its conversation's. `channel` absent: #all. */
  windowFor(conv: string, channel?: string): ChatTarget | null {
    const own = { conv, channel: channel ?? ALL_CHANNEL };
    if (this.windows.has(chatWindowKey(own))) return own;
    return this.windows.has(conv) ? { conv } : null;
  }

  owns(contents: WebContents): boolean {
    for (const w of this.windows.values()) if (!w.isDestroyed() && w.webContents === contents) return true;
    return false;
  }

  /** Someone is looking at it: the shell doesn't notify about it. */
  isFocused(conv: string, channel?: string): boolean {
    const own = chatWindowKey({ conv, channel: channel ?? ALL_CHANNEL });
    return !!this.windows.get(own)?.isFocused() || !!this.windows.get(conv)?.isFocused();
  }

  /** Open the window, or bring it up. `at`: the cursor where it was dropped,
   *  which an open one moves to as well. `from`: the row in the main page it
   *  was opened from — a new one grows out of it. */
  show(target: ChatTarget, at?: Point, from?: PageRect): void {
    const open = this.windows.get(chatWindowKey(target));
    if (open && !open.isDestroyed()) {
      if (at) open.setBounds(droppedBounds(at, open.getBounds(), screen.getDisplayNearestPoint(at).workArea));
      if (open.isMinimized()) open.restore();
      open.show();
      open.focus();
      return;
    }
    const row = from && !at && !target.channel && !stillMotion() ? this.onScreen(from) : null;
    this.create(target, this.placeFor(target, at), row);
  }

  /** The ones that were open when Mafold last quit. */
  restore(): void {
    for (const s of [...this.saved].reverse()) if (s.open && !this.windows.has(chatWindowKey(s))) this.create(s, this.placeFor(s));
  }

  /** Sign-out: nothing of that account stays on screen. */
  closeAll(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.close();
  }

  /** The page in a window closing it: its conversation is gone. */
  closeOf(contents: WebContents): void {
    for (const w of this.windows.values()) if (!w.isDestroyed() && w.webContents === contents) w.close();
  }

  /** The window that page is in, for its lights (bridge.ts). */
  windowOf(contents: WebContents): BrowserWindow | null {
    for (const w of this.windows.values()) if (!w.isDestroyed() && w.webContents === contents) return w;
    return null;
  }

  /** The page's ‹: the main window comes up on its conversation, and this one
   *  goes — folding into the conversation's row there, when the main page says
   *  where that is (`chat-window-fold`). */
  async returnTo(contents: WebContents): Promise<void> {
    const found = [...this.windows].find(([, w]) => !w.isDestroyed() && w.webContents === contents);
    if (!found) return;
    const [key, win] = found;
    // A second ‹ while it's on its way is the same one.
    if (this.gone.has(key) || this.returning.has(key)) return;
    this.returning.add(key);
    win.once("closed", () => this.returning.delete(key));
    const conv = key.split("/")[0];
    const main = this.shell.window;
    // Hidden or in the Dock, it has no row to aim at until it's back.
    if (main && !main.isDestroyed() && (main.isMinimized() || !main.isVisible())) this.shell.showWindow();
    const to = stillMotion() ? null : await this.rowOf(conv);
    const shot = to ? await win.webContents.capturePage().catch(() => null) : null;
    const g = to && !win.isDestroyed() ? await ghost(this.flight(key, { from: win.getBounds(), to, kind: "fold" }), shot) : null;
    if (win.isDestroyed()) return g?.close();
    if (g) {
      g.show();
      // The still is on screen before the window leaves it.
      await new Promise((r) => setTimeout(r, 30));
      win.hide();
      this.shell.showWindow();
      await g.play();
    }
    this.gone.add(key);
    this.tell();
    this.shell.showWindow();
    this.shell.emit("navigate", `#${conv}`);
    if (!win.isDestroyed()) win.close();
    g?.close();
  }

  /** An update's restart closes the windows before `before-quit` on macOS. */
  keepForNextLaunch(): void {
    this.staying = true;
  }

  private placeFor(target: ChatTarget, at?: Point): Bounds {
    const known = this.saved.find((s) => chatWindowKey(s) === chatWindowKey(target))?.bounds;
    const size = known ? { width: known.width, height: known.height } : target.channel ? CHAT_WINDOW_SIZE : CONV_WINDOW_SIZE;
    if (at) return droppedBounds(at, size, screen.getDisplayNearestPoint(at).workArea);
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    const there = known ? fit({ bounds: known, maximized: false }, areas, MIN_SIZE) : null;
    if (there) return { x: there.x, y: there.y, width: there.width, height: there.height };
    const main = this.shell.window;
    const from = main && !main.isDestroyed() ? main.getBounds() : screen.getPrimaryDisplay().workArea;
    return cascadedBounds(from, this.windows.size, size, screen.getDisplayMatching(from).workArea);
  }

  private create(target: ChatTarget, bounds: Bounds, growFrom: Rectangle | null = null): void {
    const { conv, channel } = target;
    const key = chatWindowKey(target);
    const shell = this.shell;
    const mac = this.os === "macos";
    const os = capsFor(this.os);
    const prefs = pageWebPreferences(shell, this.os, CHAT_WINDOW_CAPS.filter((c) => os.includes(c)));
    const cut = this.cutFor();
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: "Mafold",
      // Growing out of its row, it shows when the still has.
      show: !growFrom,
      // Cut, the window is see-through and its content view stands on the
      // page's ground in its place, as the main window's does (frame.ts).
      backgroundColor: cut ? CLEAR : ground(),
      ...(cut ? { transparent: true, hasShadow: true } : {}),
      autoHideMenuBar: !mac,
      icon: mac ? undefined : resourcePath("icon-256.png"),
      // macOS: no title bar — the page draws the lights at the head of its
      // list; until it does, the system's sit in the same slot.
      ...(mac ? { titleBarStyle: "hidden" as const, trafficLightPosition: NATIVE_TRAFFIC_POSITION } : {}),
      webPreferences: {
        ...prefs,
        additionalArguments: [...(prefs.additionalArguments ?? []), `--mafold-solo-chat=${conv}`, ...(channel ? [`--mafold-solo-channel=${channel}`] : [])],
      },
    });
    const page = win.webContents;
    this.windows.set(key, win);
    this.note(target, win, true);
    this.tell();
    log("chat window opened");

    guardMainNavigation(page, shell, offlineUrl());
    attachContextMenu(page, shell);
    zoomOnWheel(shell, page);
    restoreZoom(shell, page);
    const url = relaunchUrl(shell.cfg, `#${conv}`);
    page.on("did-fail-load", (_e, code, desc, failed, isMainFrame) => {
      // -3 = ERR_ABORTED: a navigation replaced by another, not a failure.
      if (!isMainFrame || code === -3 || failed.startsWith(offlineUrl())) return;
      log("chat window load failed:", code, desc, redact(failed));
      void page.loadURL(offlinePage(shell, url));
    });
    page.on("render-process-gone", (_e, details) => {
      log("chat window renderer gone:", details.reason);
      if (details.reason === "clean-exit") return;
      setTimeout(() => {
        if (!page.isDestroyed()) page.reload();
      }, 1000);
    });

    const reground = () => {
      if (win.isDestroyed()) return;
      if (cut) win.contentView.setBackgroundColor(ground());
      else win.setBackgroundColor(ground());
    };
    reground();
    nativeTheme.on("updated", reground);

    const corner = (radius: number) => {
      if (!cut || win.isDestroyed() || this.cornersOf.get(key) === radius) return;
      this.cornersOf.set(key, radius);
      cut(win, radius);
      // The system's shadow is the window's shape, read once until it's told.
      win.invalidateShadow();
    };
    corner(WINDOW_CORNER);

    // Full screen takes the page's lights away, as in the main window (window.ts).
    if (mac) {
      const windowState = () => {
        corner(win.isFullScreen() ? 0 : WINDOW_CORNER);
        if (!page.isDestroyed()) page.send(IPC.event, { name: "window", payload: win.isFullScreen() ? "fullscreen" : "windowed" });
      };
      win.on("enter-full-screen", windowState);
      win.on("leave-full-screen", windowState);
    }

    let saveTimer: NodeJS.Timeout | null = null;
    const saveSoon = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) this.note(target, win, true);
      }, 500);
    };
    win.on("resize", saveSoon);
    win.on("move", saveSoon);
    win.on("close", () => {
      if (saveTimer) clearTimeout(saveTimer);
      this.note(target, win, this.staying || this.shell.quitting);
    });
    win.once("closed", () => {
      nativeTheme.off("updated", reground);
      this.windows.delete(key);
      this.cornersOf.delete(key);
      this.gone.delete(key);
      this.tell();
    });

    const painted = growFrom
      ? new Promise<void>((done) => {
          win.once("ready-to-show", () => done());
          setTimeout(done, PAINT_MS);
        })
      : null;
    void page.loadURL(url);
    if (growFrom && painted) void this.grow(key, win, growFrom, painted);
  }

  /** A new window out of its row: the panel grows to where the window is and
   *  stays until the page under it has painted. */
  private async grow(key: string, win: BrowserWindow, from: Rectangle, painted: Promise<void>): Promise<void> {
    const g = await ghost(this.flight(key, { from, to: win.getBounds(), kind: "grow" }), null);
    if (g) {
      g.show();
      await g.play();
    }
    await painted;
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
    // A frame for the window to be on screen under it.
    setTimeout(() => g?.close(), 60);
  }

  private note(target: ChatTarget, win: BrowserWindow, open: boolean): void {
    if (win.isMinimized() || win.isFullScreen()) {
      const had = this.saved.find((s) => chatWindowKey(s) === chatWindowKey(target));
      if (!had) return;
      this.saved = remembered(this.saved, { ...had, open });
    } else {
      this.saved = remembered(this.saved, { ...target, bounds: win.getNormalBounds(), open });
    }
    writeChatWindows(this.file, this.saved);
  }
}
