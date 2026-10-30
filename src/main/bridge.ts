// The main-process half of `window.mafoldHost`. Every handler first asks who is
// calling: only the main window's top frame, showing the web origin, is
// answered. Child windows, subframes, the offline page — dropped silently.

import { app, ipcMain, nativeTheme, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { arrangedBounds } from "./chrome";

import { saveAppearance } from "./appearance";
import { RateLimit } from "./limits";
import { log } from "./log";
import { notifyPermission, openNotifySettings, showNotification, testNotification } from "./notify";
import { originOf } from "./policy";
import type { Shell } from "./shell";
import { readAppearance, readAuthorizeUrl, readEventName, readLocale, readNotification, readUnread, readWindowAction, sameUnread } from "./validate";
import {
  IPC,
  type AdoptCheck,
  type AdoptResult,
  type BotRestartResult,
  type CliInstallResult,
  type CliRollbackCheck,
  type CliUpdateResult,
  type DaemonEnableResult,
  type DaemonStatus,
  type DiagnoseResult,
  type HostUpdate,
  type LogError,
  type LogTail,
  type NotifyPermission,
  type OAuthResult,
  type RuntimeLoginResult,
  type RuntimeLoginStart,
} from "../shared/desktopHost.generated";
import type { DaemonManager } from "./daemon/manager";
import { isChannel, isUsername } from "./daemon/model";
import type { Updater } from "./updater";

/** The page's name for one follow: it counts them from 1. */
const isFollowId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

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
  updater: Updater,
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
  on(IPC.unsubscribe, (_e, name) => {
    const n = readEventName(name);
    if (n) shell.unsubscribe(n);
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

  // The window's ground, the tray and the menus follow the page's theme — and
  // so does the next launch's first frame (appearance.ts). The page applies
  // its theme on every load; only a change is written.
  on(IPC.setAppearance, (_e, mode) => {
    const m = readAppearance(mode);
    if (!m || m === nativeTheme.themeSource) return;
    nativeTheme.themeSource = m;
    saveAppearance(app.getPath("userData"), m);
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
  // A bot's handle (`owner:bot`) the page passes; only one configured here is
  // restarted (`DaemonManager.restart`) — and, when the page says who it is
  // signed in as, only that person's.
  handle<BotRestartResult>(
    IPC.daemonRestart,
    (name, username) =>
      isUsername(name) && (username === undefined || isUsername(username))
        ? daemon.restart(name, username)
        : { ok: false, error: "refused" },
    { ok: false, error: "refused" },
  );
  handle<DaemonEnableResult>(
    IPC.daemonRelogin,
    (username) => (isUsername(username) ? daemon.relogin(username) : { error: "invalid account" }),
    { error: "refused" },
  );
  handle<RuntimeLoginStart>(
    IPC.runtimeLogin,
    (runtime) => (typeof runtime === "string" ? daemon.runtimeLogin(runtime) : { error: "refused" }),
    { error: "refused" },
  );
  handle<RuntimeLoginResult>(IPC.runtimeLoginCode, (code) => daemon.runtimeLoginCode(code), { ok: false, error: "refused" });
  handle<void>(IPC.runtimeLoginCancel, () => daemon.runtimeLoginCancel(), undefined);

  // This computer's logs (activity center D4). Like everything here, only the
  // main window's page is answered: a card runs in a frame of its own and
  // never reaches the bridge. `bot` null = the supervisor's log.
  const logSource = (username: unknown, bot: unknown): username is string => isUsername(username) && (bot === null || isUsername(bot));
  handle<LogTail>(
    IPC.daemonLogs,
    (username, bot, lines) => (logSource(username, bot) ? daemon.logs(username, bot as string | null, lines) : { ok: false, error: "refused" }),
    { ok: false, error: "refused" },
  );
  handle<{ ok: true } | { ok: false; error: LogError }>(
    IPC.logsFollow,
    (id, username, bot, lines) =>
      isFollowId(id) && logSource(username, bot) ? daemon.followLogs(id, username, bot as string | null, lines) : { ok: false, error: "refused" },
    { ok: false, error: "refused" },
  );
  on(IPC.logsStop, (_e, id) => {
    if (isFollowId(id)) daemon.stopFollow(id, "closed");
  });
  handle<DiagnoseResult>(IPC.diagnose, () => daemon.diagnose(), { ok: false, error: "refused" });

  // mafold-cli's own updates here (activity center D5). The page passes a
  // boolean or a channel name, nothing else; a rollback asks natively first.
  handle<CliUpdateResult>(IPC.cliCheck, () => daemon.checkUpdate(), { ok: false, error: "refused" });
  handle<CliInstallResult>(IPC.cliInstall, () => daemon.updateCli(), { ok: false, error: "refused" });
  handle<CliUpdateResult>(
    IPC.cliAutoUpdate,
    (on) => (typeof on === "boolean" ? daemon.setAutoUpdate(on) : { ok: false, error: "refused" }),
    { ok: false, error: "refused" },
  );
  handle<CliUpdateResult>(IPC.cliChannel, (channel) => (isChannel(channel) ? daemon.setChannel(channel) : { ok: false, error: "refused" }), {
    ok: false,
    error: "refused",
  });
  handle<CliRollbackCheck>(IPC.cliRollbackCheck, () => daemon.rollbackCheck(), { ok: false, error: "refused" });
  handle<CliInstallResult>(IPC.cliRollback, () => daemon.rollback(), { ok: false, error: "refused" });

  // Handing this computer's bots to Mafold (activity center D6): the page
  // passes nothing; the shell asks natively first.
  handle<AdoptCheck>(IPC.adoptCheck, () => daemon.adoptCheck(), { ok: false, error: "refused" });
  handle<AdoptResult>(IPC.adopt, () => daemon.adopt(), { ok: false, error: "refused" });

  // The shell's own update (updater.ts): where it has got, restart into a ready
  // one, and a check — at most one a minute reaches the feed; sooner, the
  // answer is the state as it is.
  const checks = new RateLimit(60_000);
  handle<HostUpdate | null>(IPC.updateState, () => updater.state(), null);
  handle<boolean>(IPC.updateInstall, () => updater.install(), false);
  handle<HostUpdate | null>(IPC.updateCheck, () => (checks.allow("check", Date.now()) ? updater.check() : updater.state()), null);

  // Expiry of abandoned authorizations, so a forgotten tab's promise settles.
  setInterval(() => shell.pending.sweep(Date.now()), 60_000).unref();
}
