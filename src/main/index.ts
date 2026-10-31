// Mafold desktop — the main process.
//
// One window showing the live web app; the shell around it adds what a browser
// tab cannot: a dock/taskbar badge and a tray, OS notifications, native menus,
// `mafold://` links, sign-in in the system browser, opening at login, and its
// own updates. The page reaches all of it through `window.mafoldHost`
// (src/preload, contract in client-shared/desktopHost.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, Menu, nativeTheme, powerMonitor } from "electron";

import { readSavedAppearance } from "./appearance";
import { launchedAtLogin, makeAutostart } from "./autostart";
import { registerBridge } from "./bridge";
import { APP_ID, resolveConfig } from "./config";
import { attachContextMenu } from "./contextMenu";
import { coverBounds, coverUp } from "./cover";
import { cliPaths } from "./daemon/cli";
import { confirmText, DaemonManager } from "./daemon/manager";
import { cliEnv } from "./daemon/shellEnv";
import { deepLinkInArgv, parseDeepLink } from "./deeplink";
import { Strings, type StringTable } from "./i18n";
import { initLog, log } from "./log";
import { buildMenu } from "./menu";
import { initNotifications, notificationsShown, notifyPermission, saw, updateNoticesPosted } from "./notify";
import { staticPath } from "./paths";
import { noteRelaunch, noteVersion, relaunchUrl, takeRelaunch } from "./relaunch";
import { enablePasskeys, guardAllContents, guardSession } from "./security";
import { Shell } from "./shell";
import { createTray, refreshTray, trayLabels } from "./tray";
import { initUpdater } from "./updater";
import { createMainWindow, saveWindowState } from "./window";
import { DEEP_LINK_SCHEME, type HostEventName } from "../shared/desktopHost.generated";

const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const cfg = resolveConfig(process.env, app.isPackaged);
if (cfg.test?.userData) app.setPath("userData", cfg.test.userData);
if (os === "windows") app.setAppUserModelId(APP_ID);

// A window closed to the tray (or minimised) stops painting — its page is told
// it is hidden, like a background tab — but keeps its timers at their pace:
// the socket's heartbeat and watchdog run on them, and a hidden Mafold still
// receives messages and notifies about them. Without these Chromium aligns a
// hidden page's timers to a second, then after five minutes to a minute, and
// lowers its process priority. (window.ts leaves background throttling on.)
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "IntensiveWakeUpThrottling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

let shell: Shell | null = null;
const early: string[] = [];

function openDeepLink(raw: string): void {
  if (!shell) {
    early.push(raw);
    return;
  }
  const link = parseDeepLink(raw);
  if (!link) {
    log("ignored deep link");
    return;
  }
  if (link.kind === "app") {
    shell.showWindow();
    shell.emit("navigate", link.hash);
    return;
  }
  // An OAuth result from the system browser. Only a state we registered counts.
  if (shell.pending.deliver(link.state, { code: link.code, error: link.error }, Date.now())) shell.showWindow();
}

// macOS delivers links as an event — possibly before `ready`, so it is wired
// at load time and early links wait in `early`.
app.on("open-url", (e, url) => {
  e.preventDefault();
  openDeepLink(url);
});

if (!app.requestSingleInstanceLock()) {
  // Another Mafold is running; it receives our argv (and any link in it).
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = deepLinkInArgv(argv);
    if (link) openDeepLink(link);
    else shell?.showWindow();
  });

  app.on("before-quit", () => {
    if (shell) shell.quitting = true;
  });
  // Closing the window is not quitting (the tray keeps Mafold reachable).
  app.on("window-all-closed", () => {});
  // macOS: clicking the dock icon brings the window back.
  app.on("activate", () => shell?.showWindow());

  void app.whenReady().then(() => {
    initLog(app.getPath("logs"));
    const table = JSON.parse(readFileSync(staticPath("strings.json"), "utf8")) as StringTable;
    const s = new Shell(cfg, new Strings(table, app.getLocale()), app.getVersion());
    log(`start ${s.version} (${os}) ${app.isPackaged ? "packaged" : "unpackaged"}`);

    // Only a packaged app claims `mafold://`. An unpackaged run would register
    // the bare Electron binary as the system-wide handler.
    if (app.isPackaged && !app.isDefaultProtocolClient(DEEP_LINK_SCHEME)) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

    enablePasskeys(s, os);
    guardAllContents(s);
    guardSession(s);
    const userData = app.getPath("userData");
    // The light / dark picked in the app last time, before there is a window:
    // its ground and the page's first frame open in it (appearance.ts).
    nativeTheme.themeSource = readSavedAppearance(userData);
    // A restart into a new version left a note: open on the conversation (the
    // garden, the moments) it left, not the list (relaunch.ts).
    const back = takeRelaunch(userData, Date.now());
    if (back) log("back where", back.from || "the last version", "left off");
    const { win, page } = createMainWindow(s, { startHidden: launchedAtLogin(os), os, url: relaunchUrl(cfg, back?.hash ?? null) });
    attachContextMenu(page, s);

    let menuKey = "";
    const redrawMenu = () => {
      const key = `${s.strings.language}|${s.updateReady}`;
      if (key === menuKey) return;
      menuKey = key;
      Menu.setApplicationMenu(buildMenu(s, os));
    };
    redrawMenu();
    createTray(s, os);
    // Rebuilding a native menu and redrawing the menu-bar item is not free,
    // and changes can arrive in bursts (unread while several bots stream, a
    // language switch); one redraw per quarter second carries them all.
    let redraw: NodeJS.Timeout | null = null;
    s.onChange(() => {
      redraw ??= setTimeout(() => {
        redraw = null;
        redrawMenu();
        refreshTray(s, os);
      }, 250);
    });

    // Run bots on this computer. Confirmations use the build's own strings
    // (`frozen`): the page — and any card running in it — must not be able to
    // choose what this dialog says.
    const daemon = new DaemonManager({
      paths: cliPaths(cfg, os),
      env: () => cliEnv(os),
      confirm: async (ask) => {
        if (cfg.test?.confirm) return cfg.test.confirm === "yes";
        const text = confirmText(ask, (k, vars) => s.strings.frozen(k, vars));
        s.showWindow();
        const r = await dialog.showMessageBox(win, {
          type: "question",
          message: text.message,
          detail: text.detail,
          buttons: [text.ok, s.strings.frozen("desktop.daemon.cancel")],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return r.response === 0;
      },
      emit: (status) => s.emit("daemon", JSON.stringify(status)),
      openExternal: (url) => s.openExternal(url, "runtime-login"),
      emitLogs: (frame) => s.emit("logs", JSON.stringify(frame)),
      // The diagnostics file goes where the person picks, in the system's own
      // dialog: the page can ask for one, never choose where it lands.
      saveAs: async (name) => {
        if (cfg.test?.saveAs) return cfg.test.saveAs;
        s.showWindow();
        const r = await dialog.showSaveDialog(win, {
          defaultPath: join(app.getPath("downloads"), name),
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    });
    s.onSubscribe((name) => {
      if (name === "daemon") void daemon.refresh();
    });
    // A followed log stops once nobody can see it: the window closed (to the
    // tray), or the page stopped listening — it went, reloaded, or is done.
    // `close`, not `hide`: macOS says `hide` for a window merely covered.
    win.on("close", () => daemon.stopFollow(null, "closed"));
    s.onUnsubscribe((name) => {
      if (name === "logs") daemon.stopFollow(null, "closed");
    });
    // While the page is listening and someone can see it, keep the picture
    // fresh (a bot started elsewhere, the cli updated itself, …).
    setInterval(() => {
      if (s.isSubscribed("daemon") && win.isVisible()) void daemon.refresh();
    }, 30_000).unref();
    app.on("before-quit", () => daemon.dispose());

    initNotifications(s, userData, os);
    const from = noteVersion(userData, s.version);
    if (from) log("updated from", from);
    const updater = initUpdater(s, os, {
      updatedFrom: from,
      // On the way out to the new version: the window's place (on macOS the
      // window is closed before `before-quit` could save it), then where the
      // page is — only its hash, and only one the web app writes.
      beforeInstall: () => {
        saveWindowState(win);
        if (!page.isDestroyed()) noteRelaunch(userData, page.getURL(), s.version, cfg, Date.now());
      },
    });
    registerBridge(s, os, makeAutostart(os), daemon, updater);

    const resume = () => s.emit("resume");
    powerMonitor.on("resume", resume);
    powerMonitor.on("unlock-screen", resume);

    shell = s;
    const first = deepLinkInArgv(process.argv);
    if (first) early.push(first);
    for (const raw of early.splice(0)) openDeepLink(raw);

    // e2e hooks: unpackaged runs started by the test suite only.
    if (!app.isPackaged && process.env.MAFOLD_DESKTOP_TEST === "1") {
      (globalThis as Record<string, unknown>).__mafoldTest = {
        deepLink: (url: string) => openDeepLink(url),
        trayLabels: () => trayLabels(),
        unread: () => s.unread,
        notificationsShown: () => notificationsShown(),
        notifyPermission: () => notifyPermission(),
        // What a refused / shown notification records, without a notification
        // server under xvfb to refuse or show one.
        sawNotifyPermission: (p: "allowed" | "blocked" | "unknown") => saw(s, p),
        pendingAuth: () => s.pending.size,
        // 主窗口开始加载另一份文档、当前这页可能要走了(shell.ts leavingDocument):
        // document.spec 等壳看见了再发深链,不靠猜时间。
        pageLeaving: () => s.pageLeaving,
        // What the shell believes the page listens to, and one event through it.
        subscribed: (name: HostEventName) => s.isSubscribed(name),
        emit: (name: HostEventName, payload?: string) => s.emit(name, payload),
        language: () => s.strings.language,
        // One of electron-updater's events, as the feed would send it (there is
        // no feed unpackaged); the restart it allows is written to externalLog.
        updateEvent: (name: string, info?: unknown) => updater.feed(name, info),
        updateReady: () => s.updateReady,
        // How many times the shell decided to post "a new version is ready",
        // and a click on it — xvfb has no notification server to show or click one.
        updateNotices: () => updateNoticesPosted(),
        updateNoticeClick: () => updater.askRestart("notice"),
        // 开窗时盖在上面的加载画面(cover.ts):还在不在、盖在哪。
        coverUp: () => coverUp(),
        coverBounds: () => coverBounds(),
        // The window's frame (frame.ts): the phone layout's title bar up or not
        // (macOS), where the page is in the window, the window's minimum, where
        // the system's lights are.
        frame: () => {
          const w = s.window;
          if (!w || w.isDestroyed() || !s.frame) return null;
          return {
            bar: s.frame.shown,
            page: s.frame.pageBounds(),
            min: w.getMinimumSize(),
            lights: process.platform === "darwin" ? w.getWindowButtonPosition() : null,
          };
        },
        // The main window's page — a view in the window, not the window (window.ts).
        page: () => s.page,
      };
    }
  });
}
