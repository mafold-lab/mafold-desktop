// The main window: the live web app, nothing else —— 只在它加载时,上面盖一张
// 跟网页第一帧同一张的静止加载画面(cover.ts)。

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, nativeTheme, Notification, screen } from "electron";

import { raiseCover } from "./cover";
import { log, redact } from "./log";
import { resourcePath, staticPath } from "./paths";
import { guardMainNavigation, PARTITION } from "./security";
import type { Shell } from "./shell";
import { DEFAULT_SIZE, fit, MIN_SIZE, readSaved, writeSaved } from "./windowState";
import { capsFor, NATIVE_TRAFFIC_POSITION } from "./chrome";
import { APP_GROUND } from "../shared/appGround.generated";

export const offlineUrl = () => pathToFileURL(staticPath("offline.html")).href;

/** The app's own ground (client-shared/appGround.ts, the web's `--jBg`) in the
 *  appearance the shell is in: the page's pick (bridge.ts `setAppearance`,
 *  restored at launch by index.ts), or the system's. */
const ground = () => APP_GROUND[nativeTheme.shouldUseDarkColors ? "dark" : "light"];

const stateFile = () => join(app.getPath("userData"), "window-state.json");

/** Where the window is, written down now — not half a second after a move
 *  (`saveSoon` below), and not at `before-quit`: an update's restart on macOS
 *  (Squirrel) closes the window before that, when there is nothing left to
 *  save. updater.ts calls this before it installs (index.ts). */
export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  writeSaved(stateFile(), { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
}

/** `url`: what the window opens — the start page, or where a restart into a
 *  new version left off (relaunch.ts). */
export function createMainWindow(shell: Shell, opts: { startHidden: boolean; os: "macos" | "windows" | "linux"; url: string }): BrowserWindow {
  const placed = fit(readSaved(stateFile()), screen.getAllDisplays().map((d) => d.workArea), MIN_SIZE);
  const mac = opts.os === "macos";

  const win = new BrowserWindow({
    ...(placed ? { x: placed.x, y: placed.y, width: placed.width, height: placed.height } : DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    // 盖层(cover.ts)盖上了再出来 —— 就在下面,不等网页。
    show: false,
    title: "Mafold",
    // What shows before the page paints, between documents and around a
    // resize: the colour the page itself stands on, so nothing changes as it
    // arrives.
    backgroundColor: ground(),
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
  //
  // New means COMMITTED (`did-navigate`, main frame, never same-document), not
  // started. A navigation that only starts leaves the page in place, drawing
  // its lights and listening: a file's download link (the media viewer's ↓,
  // which the shell turns into a download), a link it hands to the browser or
  // refuses (security.ts). Treating those as new put the system's lights back
  // on top of the page's — two sets — and dropped every event the page had
  // subscribed to (deep links, commands, resume) until it reloaded.
  //
  // Between the start and the outcome the page may be on its way out, so a
  // deep link is held (shell.ts `leavingDocument`) for whichever page listens
  // next. The shell's own guard settles a download or a hand-off on the spot
  // (security.ts); loading that stops without a new document settles the rest.
  const newDocument = () => {
    shell.resetSubscriptions();
    shell.pageHung = false;
    if (mac && !win.isDestroyed()) win.setWindowButtonVisibility(true);
  };
  win.webContents.on("did-start-navigation", (e) => {
    if (e.isMainFrame && !e.isSameDocument) shell.leavingDocument();
  });
  win.webContents.on("did-navigate", newDocument);
  win.webContents.on("did-stop-loading", () => shell.stayed());

  // A page that stopped answering cannot take the update's restart from the
  // tray or the menu (updater.ts): until it answers again they restart at once.
  win.webContents.on("unresponsive", () => {
    shell.pageHung = true;
  });
  win.webContents.on("responsive", () => {
    shell.pageHung = false;
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

  // The page picks light or dark, or the system switches: the ground follows.
  const reground = () => {
    if (!win.isDestroyed()) win.setBackgroundColor(ground());
  };
  nativeTheme.on("updated", reground);
  win.once("closed", () => nativeTheme.off("updated", reground));

  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED: a navigation replaced by another, not a failure.
    if (!isMainFrame || code === -3 || url.startsWith(offlineUrl())) return;
    log("load failed:", code, desc, redact(url));
    void win.loadURL(offlineUrl() + "#" + encodeURIComponent(JSON.stringify({
      title: shell.strings.t("desktop.offline.title"),
      body: shell.strings.t("desktop.offline.body"),
      retry: shell.strings.t("desktop.offline.retry"),
      url: shell.cfg.startUrl,
      // Both: the page follows the appearance through prefers-color-scheme.
      ground: { light: APP_GROUND.light, dark: APP_GROUND.dark },
    })));
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    log("renderer gone:", details.reason);
    // The document died with its renderer: nothing draws the lights now.
    newDocument();
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
  const save = () => saveWindowState(win);
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  };
  win.on("resize", saveSoon);
  win.on("move", saveSoon);
  win.on("maximize", saveSoon);
  win.on("unmaximize", saveSoon);
  app.on("before-quit", save);

  // 窗口当场出来,上面盖着跟网页第一帧同一张加载画面,网页好了再撤(cover.ts)——
  // 不再等网页第一帧(ready-to-show):网络慢时点了图标好几秒什么都没有。开机在托盘
  // 里起的(startHidden)照样不出来,盖层照样盖上、到时候撤。
  raiseCover(win, { webOrigin: shell.cfg.webOrigin, offlineUrl: offlineUrl(), ground });
  if (!opts.startHidden) win.show();

  void win.loadURL(opts.url);
  return win;
}
