// The main window: the live web app, nothing else.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, nativeTheme, Notification, screen } from "electron";

import { log, redact } from "./log";
import { resourcePath, staticPath } from "./paths";
import { guardMainNavigation, PARTITION } from "./security";
import type { Shell } from "./shell";
import { DEFAULT_SIZE, fit, minSizeFor, readSaved, writeSaved } from "./windowState";
import { capsFor, NATIVE_TRAFFIC_POSITION } from "./chrome";

export const offlineUrl = () => pathToFileURL(staticPath("offline.html")).href;

export function createMainWindow(shell: Shell, opts: { startHidden: boolean; os: "macos" | "windows" | "linux" }): BrowserWindow {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const min = minSizeFor(opts.os);
  const placed = fit(readSaved(stateFile), screen.getAllDisplays().map((d) => d.workArea), min);
  const mac = opts.os === "macos";

  const win = new BrowserWindow({
    ...(placed ? { x: placed.x, y: placed.y, width: placed.width, height: placed.height } : DEFAULT_SIZE),
    minWidth: min.width,
    minHeight: min.height,
    show: false,
    title: "Mafold",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111113" : "#f6f6f8",
    autoHideMenuBar: !mac,
    icon: mac ? undefined : resourcePath("icon-256.png"),
    // macOS: no title bar — the page runs to the top edge and draws the lights
    // itself (chrome.ts); until it does, the system's sit in the same slot.
    ...(mac ? { titleBarStyle: "hidden" as const, trafficLightPosition: NATIVE_TRAFFIC_POSITION } : {}),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: true,
      plugins: true, // the built-in PDF viewer behind attachment previews
      // Background throttling stays ON: a window closed to the tray stops
      // painting (with it off, a hidden window kept rendering every streamed
      // reply — ~23% CPU with six bots writing). Its timers, which the socket
      // lives on, keep their pace through the switches set in index.ts.
      additionalArguments: [
        `--mafold-web-origin=${shell.cfg.webOrigin}`,
        `--mafold-version=${shell.version}`,
        `--mafold-os=${opts.os}`,
        `--mafold-caps=${capsFor(opts.os).join(",")}`,
      ],
    },
  });
  shell.window = win;
  if (placed?.maximized) win.maximize();

  guardMainNavigation(win.webContents, shell, offlineUrl());

  // A new document starts with no listeners; same-document (hash) navigations
  // keep them. Nor has it drawn any lights yet: the system's come back until
  // it says it has (bridge.ts `setWindowControls`), so a page that never does
  // — the offline page, a slow load — still has a way to close the window.
  win.webContents.on("did-start-navigation", (e) => {
    if (!e.isMainFrame || e.isSameDocument) return;
    shell.resetSubscriptions();
    if (mac) win.setWindowButtonVisibility(true);
  });

  // In full screen macOS hides the window's chrome; the page hides its lights
  // with it, and the system's (which full screen reveals at the top) take over.
  if (mac) {
    const windowState = () => shell.emit("window", win.isFullScreen() ? "fullscreen" : "windowed");
    win.on("enter-full-screen", windowState);
    win.on("leave-full-screen", windowState);
    shell.onSubscribe((name) => {
      if (name === "window") windowState();
    });
  }

  win.once("ready-to-show", () => {
    if (!opts.startHidden) win.show();
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED: a navigation replaced by another, not a failure.
    if (!isMainFrame || code === -3 || url.startsWith(offlineUrl())) return;
    log("load failed:", code, desc, redact(url));
    void win.loadURL(offlineUrl() + "#" + encodeURIComponent(JSON.stringify({
      title: shell.strings.t("desktop.offline.title"),
      body: shell.strings.t("desktop.offline.body"),
      retry: shell.strings.t("desktop.offline.retry"),
      url: shell.cfg.startUrl,
    })));
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    log("renderer gone:", details.reason);
    if (details.reason === "clean-exit") return;
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, 1000);
  });

  // Closing the window keeps Mafold running (notifications, the tray, deep
  // links); only Quit ends it. The first time on Windows, say where it went.
  let toldAboutTray = false;
  win.on("close", (e) => {
    if (shell.quitting) return;
    e.preventDefault();
    win.hide();
    if (opts.os !== "macos" && !toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: "Mafold", body: shell.strings.t("desktop.tray.stillRunning"), silent: true }).show();
    }
  });

  // Stop the taskbar flashing once the person is looking.
  win.on("focus", () => win.flashFrame(false));

  let saveTimer: NodeJS.Timeout | null = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeSaved(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  };
  win.on("resize", saveSoon);
  win.on("move", saveSoon);
  win.on("maximize", saveSoon);
  win.on("unmaximize", saveSoon);
  app.on("before-quit", save);

  void win.loadURL(shell.cfg.startUrl);
  return win;
}
