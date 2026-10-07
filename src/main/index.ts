// Mafold desktop — the main process.
//
// One window showing the live web app; the shell around it adds what a browser
// tab cannot: a dock/taskbar badge and a tray, OS notifications, native menus,
// `mafold://` links, sign-in in the system browser, opening at login, and its
// own updates. The page reaches all of it through `window.mafoldHost`
// (src/preload, contract in client-shared/desktopHost.ts).

import { readFileSync } from "node:fs";
import { app, dialog, Menu, powerMonitor } from "electron";

import { launchedAtLogin, makeAutostart } from "./autostart";
import { registerBridge } from "./bridge";
import { resolveConfig } from "./config";
import { attachContextMenu } from "./contextMenu";
import { cliPaths } from "./daemon/cli";
import { DaemonManager } from "./daemon/manager";
import { cliEnv } from "./daemon/shellEnv";
import { deepLinkInArgv, parseDeepLink } from "./deeplink";
import { Strings, type StringTable } from "./i18n";
import { initLog, log } from "./log";
import { buildMenu } from "./menu";
import { notificationsShown } from "./notify";
import { staticPath } from "./paths";
import { guardAllContents, guardSession } from "./security";
import { Shell } from "./shell";
import { createTray, refreshTray, trayLabels } from "./tray";
import { initUpdater } from "./updater";
import { createMainWindow } from "./window";
import { DEEP_LINK_SCHEME } from "../shared/desktopHost.generated";

const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const cfg = resolveConfig(process.env, app.isPackaged);
if (cfg.test?.userData) app.setPath("userData", cfg.test.userData);
if (os === "windows") app.setAppUserModelId("com.mafold.desktop");

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

    guardAllContents(s);
    guardSession(s);
    const win = createMainWindow(s, { startHidden: launchedAtLogin(os), os });
    attachContextMenu(win.webContents, s);

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
      confirm: async (kind, { handle, everyone }) => {
        if (cfg.test?.confirm) return cfg.test.confirm === "yes";
        const f = (k: string) => s.strings.frozen(k, { handle });
        const text =
          kind === "enable"
            ? { message: f("desktop.daemon.enable.title"), detail: f("desktop.daemon.enable.detail"), ok: f("desktop.daemon.enable.ok") }
            : {
                message: f("desktop.daemon.disable.title"),
                detail: f(everyone ? "desktop.daemon.disable.detailAll" : "desktop.daemon.disable.detailOne"),
                ok: f("desktop.daemon.disable.ok"),
              };
        s.showWindow();
        const r = await dialog.showMessageBox(win, {
          type: "question",
          message: text.message,
          detail: text.detail,
          buttons: [text.ok, f("desktop.daemon.cancel")],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return r.response === 0;
      },
      emit: (status) => s.emit("daemon", JSON.stringify(status)),
    });
    s.onSubscribe((name) => {
      if (name === "daemon") void daemon.refresh();
    });
    // While the page is listening and someone can see it, keep the picture
    // fresh (a bot started elsewhere, the cli updated itself, …).
    setInterval(() => {
      if (s.isSubscribed("daemon") && win.isVisible()) void daemon.refresh();
    }, 30_000).unref();
    app.on("before-quit", () => daemon.dispose());

    registerBridge(s, os, makeAutostart(os), daemon);
    initUpdater(s);

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
        pendingAuth: () => s.pending.size,
        language: () => s.strings.language,
      };
    }
  });
}
