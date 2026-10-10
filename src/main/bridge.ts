// The main-process half of `window.mafoldHost`. Every handler first asks who is
// calling: only the main window's top frame, showing the web origin, is
// answered. Child windows, subframes, the offline page — dropped silently.

import { ipcMain, nativeTheme, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { arrangedBounds } from "./chrome";

import { RateLimit } from "./limits";
import { log } from "./log";
import { notifyPermission, openNotifySettings, showNotification, testNotification } from "./notify";
import { originOf } from "./policy";
import type { Shell } from "./shell";
import { readAppearance, readAuthorizeUrl, readEventName, readLocale, readNotification, readUnread, readWindowAction, sameUnread } from "./validate";
import { IPC, type DaemonEnableResult, type DaemonStatus, type NotifyPermission, type OAuthResult } from "../shared/desktopHost.generated";
import type { DaemonManager } from "./daemon/manager";
import { isUsername } from "./daemon/model";

export function fromOurPage(shell: Shell, e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const w = shell.window;
  const frame = e.senderFrame;
  if (!w || w.isDestroyed() || !frame || e.sender !== w.webContents) return false;
  // Compare the frame by identity of process + routing id, not object identity.
  const main = w.webContents.mainFrame;
  return frame.processId === main.processId && frame.routingId === main.routingId && originOf(frame.url) === shell.cfg.webOrigin;
}

export function registerBridge(
  shell: Shell,
  os: "macos" | "windows" | "linux",
  autostart: { get(): boolean; set(on: boolean): void },
  daemon: DaemonManager,
): void {
  const on = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (!fromOurPage(shell, e)) return;
      try {
        fn(e, ...args);
      } catch (err) {
        log(`bridge ${channel} failed:`, err);
      }
    });
  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T, refused: T) =>
    ipcMain.handle(channel, async (e, ...args) => {
      if (!fromOurPage(shell, e)) return refused;
      try {
        return await fn(...args);
      } catch (err) {
        log(`bridge ${channel} failed:`, err);
        return refused;
      }
    });

  on(IPC.subscribe, (_e, name) => {
    const n = readEventName(name);
    if (n) shell.subscribe(n);
  });

  on(IPC.setUnread, (_e, v) => {
    const u = readUnread(v);
    // The page can send this on every change to its conversation list — a bot
    // streaming a reply is several a second. Only a summary that differs is news.
    if (!u || sameUnread(u, shell.unread)) return;
    shell.unread = u;
    shell.changed();
  });

  on(IPC.notify, (_e, v) => {
    const n = readNotification(v);
    if (n) showNotification(shell, n, os);
  });

  // Whether the system shows them (notify.ts): what the shell has seen, a test
  // notification in its own words (one every two seconds at most), and the
  // system's settings pane for Mafold.
  const tests = new RateLimit(2000);
  handle<NotifyPermission>(IPC.notifyPermission, () => notifyPermission(), "unknown");
  handle<NotifyPermission>(
    IPC.notifyTest,
    () => (tests.allow("test", Date.now()) ? testNotification(shell, os) : notifyPermission()),
    "unknown",
  );
  on(IPC.notifySettings, () => openNotifySettings(shell, os, process.getSystemVersion()));

  on(IPC.openExternal, (_e, url) => {
    if (typeof url === "string" && url.length <= 8192) shell.openExternal(url, "page");
  });

  on(IPC.setLocale, (_e, lang, strings) => {
    const l = readLocale(lang, strings);
    if (!l) return;
    shell.strings.setLocale(l.lang, l.strings);
    shell.changed();
  });

  on(IPC.setAppearance, (_e, mode) => {
    const m = readAppearance(mode);
    if (m) nativeTheme.themeSource = m;
  });

  // The window's lights, drawn by the page (chrome.ts). macOS only: elsewhere
  // the cap is not offered and these are never sent.
  if (os === "macos") {
    on(IPC.setWindowControls, (_e, drawn) => {
      if (typeof drawn === "boolean") shell.window?.setWindowButtonVisibility(!drawn);
    });
    on(IPC.windowControl, (_e, action) => {
      const w = shell.window;
      const a = readWindowAction(action);
      if (!w || !a) return;
      // close hides (window.ts), like the system's own button. zoom = fill the
      // screen and back (the page sends it for ⌥-click, as macOS does);
      // fullscreen = the green light's plain click.
      if (a === "close") w.close();
      else if (a === "minimize") w.minimize();
      else if (a === "zoom") {
        if (w.isMaximized()) w.unmaximize();
        else w.maximize();
      } else if (a === "fullscreen") w.setFullScreen(!w.isFullScreen());
      else {
        // The move-and-resize menu: out of full screen / zoom first, so the
        // window lands where asked instead of springing back on the next toggle.
        if (w.isFullScreen()) return;
        if (w.isMaximized()) w.unmaximize();
        const area = screen.getDisplayMatching(w.getBounds()).workArea;
        w.setBounds(arrangedBounds(a, area, w.getBounds()), true);
      }
    });
  }

  handle<OAuthResult>(
    IPC.oauth,
    async (url, state) => {
      const authorizeUrl = readAuthorizeUrl(url);
      if (!authorizeUrl || typeof state !== "string") return { error: "invalid request" };
      const { accepted, result } = shell.pending.begin(state, Date.now());
      if (accepted && !shell.openExternal(authorizeUrl, "oauth")) {
        shell.pending.deliver(state, { error: "could not open the browser" }, Date.now());
      }
      return result;
    },
    { error: "refused" },
  );

  handle<boolean>(IPC.autostartGet, () => autostart.get(), false);
  handle<boolean>(
    IPC.autostartSet,
    (on) => {
      if (typeof on !== "boolean") return false;
      autostart.set(on);
      return true;
    },
    false,
  );

  // Run bots on this computer (daemon/manager.ts). The page names the account;
  // the shell asks the person natively before changing anything.
  handle<DaemonStatus | null>(IPC.daemonStatus, () => daemon.refresh(), null);
  handle<DaemonEnableResult>(
    IPC.daemonEnable,
    (username) => (isUsername(username) ? daemon.enable(username) : { error: "invalid account" }),
    { error: "refused" },
  );
  handle<{ ok: boolean; error?: string }>(
    IPC.daemonDisable,
    (username) => (isUsername(username) ? daemon.disable(username) : { ok: false, error: "invalid account" }),
    { ok: false, error: "refused" },
  );

  // Expiry of abandoned authorizations, so a forgotten tab's promise settles.
  setInterval(() => shell.pending.sweep(Date.now()), 60_000).unref();
}
