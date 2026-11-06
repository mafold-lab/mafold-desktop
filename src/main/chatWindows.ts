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
//
// Unlike the main window, closing one closes it. The ones open when Mafold quits
// come back with it, where they were (chatWindowPlan.ts).

import { join } from "node:path";
import { BrowserWindow, nativeTheme, screen, type WebContents } from "electron";

import { cascadedBounds, CHAT_WINDOW_SIZE, CHAT_WINDOWS_FILE, chatWindowKey, CONV_WINDOW_SIZE, droppedBounds, readChatWindows, remembered, writeChatWindows, type ChatTarget, type SavedChatWindow } from "./chatWindowPlan";
import type { Point } from "./chrome";
import { attachContextMenu } from "./contextMenu";
import { log, redact } from "./log";
import { restoreZoom, zoomOnWheel } from "./pageZoom";
import { resourcePath } from "./paths";
import { relaunchUrl } from "./relaunch";
import { guardMainNavigation } from "./security";
import type { Shell } from "./shell";
import { offlinePage, offlineUrl, ground, pageWebPreferences } from "./window";
import { fit, MIN_SIZE, type Bounds } from "./windowState";
import { ALL_CHANNEL, CHAT_WINDOW_CAPS } from "../shared/desktopHost.generated";

export class ChatWindows {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly file: string;
  private saved: SavedChatWindow[];
  /** On the way out: the windows closing now are to come back. */
  private staying = false;

  constructor(
    private readonly shell: Shell,
    private readonly os: "macos" | "windows" | "linux",
    userData: string,
  ) {
    this.file = join(userData, CHAT_WINDOWS_FILE);
    this.saved = readChatWindows(this.file);
  }

  ids(): string[] {
    return [...this.windows.keys()];
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
   *  which an open one moves to as well. */
  show(target: ChatTarget, at?: Point): void {
    const open = this.windows.get(chatWindowKey(target));
    if (open && !open.isDestroyed()) {
      if (at) open.setBounds(droppedBounds(at, open.getBounds(), screen.getDisplayNearestPoint(at).workArea));
      if (open.isMinimized()) open.restore();
      open.show();
      open.focus();
      return;
    }
    this.create(target, this.placeFor(target, at));
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

  private create(target: ChatTarget, bounds: Bounds): void {
    const { conv, channel } = target;
    const key = chatWindowKey(target);
    const shell = this.shell;
    const prefs = pageWebPreferences(shell, this.os, CHAT_WINDOW_CAPS);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: "Mafold",
      backgroundColor: ground(),
      autoHideMenuBar: this.os !== "macos",
      icon: this.os === "macos" ? undefined : resourcePath("icon-256.png"),
      webPreferences: {
        ...prefs,
        additionalArguments: [...(prefs.additionalArguments ?? []), `--mafold-solo-chat=${conv}`, ...(channel ? [`--mafold-solo-channel=${channel}`] : [])],
      },
    });
    const page = win.webContents;
    this.windows.set(key, win);
    this.note(target, win, true);
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
      if (!win.isDestroyed()) win.setBackgroundColor(ground());
    };
    nativeTheme.on("updated", reground);

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
    });

    void page.loadURL(url);
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
