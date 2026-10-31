// The main window: the live web app, nothing else —— 只在它加载时,上面盖一张
// 跟网页第一帧同一张的静止加载画面(cover.ts)。
//
// The window is a BaseWindow and the page a view in it (`shell.page`), laid out
// by frame.ts: on macOS, in the phone layout, the shell's own title bar sits
// above the page. A BrowserWindow can't hold its page anywhere but the whole
// window. So everything about the page — loading, its events, the bridge's
// sender — is the page's web contents, never the window's.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BaseWindow, nativeTheme, Notification, screen, WebContentsView, type WebContents } from "electron";

import { raiseCover } from "./cover";
import { log, redact } from "./log";
import { resourcePath, staticPath } from "./paths";
import { guardMainNavigation, PARTITION } from "./security";
import type { Shell } from "./shell";
import { DEFAULT_SIZE, fit, MIN_SIZE, minSizeFor, readSaved, writeSaved } from "./windowState";
import { capsFor, NATIVE_TRAFFIC_POSITION } from "./chrome";
import { WindowFrame } from "./frame";
import { closePage } from "./pageClose";
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
export function saveWindowState(win: BaseWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  writeSaved(stateFile(), { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
}

/** `url`: what the window opens — the start page, or where a restart into a
 *  new version left off (relaunch.ts). */
export function createMainWindow(shell: Shell, opts: { startHidden: boolean; os: "macos" | "windows" | "linux"; url: string }): { win: BaseWindow; page: WebContents } {
  const saved = readSaved(stateFile());
  const min = minSizeFor(opts.os, saved);
  const placed = fit(saved, screen.getAllDisplays().map((d) => d.workArea), min);
  const mac = opts.os === "macos";

  const win = new BaseWindow({
    ...(placed ? { x: placed.x, y: placed.y, width: placed.width, height: placed.height } : DEFAULT_SIZE),
    minWidth: min.width,
    minHeight: min.height,
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
  });
  const caps = capsFor(opts.os);
  const view = new WebContentsView({
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
        `--mafold-caps=${caps.join(",")}`,
      ],
    },
  });
  const page = view.webContents;
  view.setBackgroundColor(ground());
  shell.window = win;
  shell.page = page;
  // Where the page sits; on macOS, the phone layout's title bar above it (frame.ts).
  const frame = new WindowFrame(win, view, caps.includes("window-titlebar"), min === MIN_SIZE);
  shell.frame = frame;
  if (placed?.maximized) win.maximize();

  // What a BrowserWindow did by itself: the window's title is the page's
  // ("(3) Mafold": the Dock's window list, Mission Control, the bar's), the
  // keyboard goes to the page when the window comes to the front, and a
  // window put away is a page put away (it stops painting: the throttling below).
  // Put away means the shell's own hide (to the tray, or opened there): macOS
  // also says `hide` for a window merely covered, and the page keeps the
  // keyboard through that (the system's occlusion already pauses its painting).
  page.on("page-title-updated", (_e, title) => {
    if (win.isDestroyed()) return;
    win.setTitle(title);
    frame.retitle(title);
  });
  win.on("focus", () => {
    if (!page.isDestroyed()) page.focus();
  });
  const putAway = () => {
    view.setVisible(false);
    win.hide();
  };
  win.on("show", () => {
    view.setVisible(true);
    if (win.isFocused() && !page.isDestroyed()) page.focus();
  });
  // A view's page outlives its window unless it is closed with it.
  win.once("closed", () => {
    if (!page.isDestroyed()) page.close();
  });

  guardMainNavigation(page, shell, offlineUrl());

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
    frame.newDocument();
    if (mac && !win.isDestroyed()) win.setWindowButtonVisibility(true);
  };
  page.on("did-start-navigation", (e) => {
    if (e.isMainFrame && !e.isSameDocument) shell.leavingDocument();
  });
  page.on("did-navigate", newDocument);
  page.on("did-stop-loading", () => shell.stayed());

  // A page that stopped answering cannot take the update's restart from the
  // tray or the menu (updater.ts): until it answers again they restart at once.
  page.on("unresponsive", () => {
    shell.pageHung = true;
  });
  page.on("responsive", () => {
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
    if (win.isDestroyed()) return;
    win.setBackgroundColor(ground());
    view.setBackgroundColor(ground());
    frame.reground(ground());
  };
  nativeTheme.on("updated", reground);
  win.once("closed", () => nativeTheme.off("updated", reground));

  page.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED: a navigation replaced by another, not a failure.
    if (!isMainFrame || code === -3 || url.startsWith(offlineUrl())) return;
    log("load failed:", code, desc, redact(url));
    void page.loadURL(offlineUrl() + "#" + encodeURIComponent(JSON.stringify({
      title: shell.strings.t("desktop.offline.title"),
      body: shell.strings.t("desktop.offline.body"),
      retry: shell.strings.t("desktop.offline.retry"),
      url: shell.cfg.startUrl,
      // Both: the page follows the appearance through prefers-color-scheme.
      ground: { light: APP_GROUND.light, dark: APP_GROUND.dark },
    })));
  });

  page.on("render-process-gone", (_e, details) => {
    log("renderer gone:", details.reason);
    // The document died with its renderer: nothing draws the lights now.
    newDocument();
    if (details.reason === "clean-exit") return;
    setTimeout(() => {
      if (!page.isDestroyed()) page.reload();
    }, 1000);
  });

  // Closing the window keeps Mafold running (notifications, the tray, deep
  // links); only Quit ends it. The first time on Windows, say where it went.
  let toldAboutTray = false;
  win.on("close", (e) => {
    if (shell.quitting) return;
    e.preventDefault();
    putAway();
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

  // Quitting gives the page its beforeunload first, as a BrowserWindow's close
  // did by itself (pageClose.ts): the first `before-quit` is held while the
  // page closes, then the quit is asked for again. Not for a page that stopped
  // answering, and not once the window is gone — an update's restart closes it
  // before `before-quit` (macOS), and the page that asked for that restart has
  // put its drafts down already (mafold-web lib/desktopUpdateSource.ts).
  let pageClosing = false;
  app.on("before-quit", (e) => {
    if (pageClosing || win.isDestroyed() || page.isDestroyed() || shell.pageHung) return;
    pageClosing = true;
    e.preventDefault();
    void closePage(page).then(() => app.quit());
  });

  // 窗口当场出来,上面盖着跟网页第一帧同一张加载画面,网页好了再撤(cover.ts)——
  // 不再等网页第一帧(ready-to-show):网络慢时点了图标好几秒什么都没有。开机在托盘
  // 里起的(startHidden)照样不出来,盖层照样盖上、到时候撤。
  raiseCover(win, { webOrigin: shell.cfg.webOrigin, offlineUrl: offlineUrl(), ground, page, frame });
  if (!opts.startHidden) win.show();
  else putAway();

  void page.loadURL(opts.url);
  return { win, page };
}
