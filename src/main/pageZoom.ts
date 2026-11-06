// Wiring zoom.ts to Electron. Electron's zoom is Chrome's (per site, the page
// laid out again), but Electron does not do two things Chrome does by itself:
// it zooms nothing on Ctrl + the mouse wheel — it only says the person asked
// (`zoom-changed`) — and it forgets the size at quit. Like Chrome, the wheel
// zooms on Windows and Linux only, and only a mouse's notched wheel: a
// trackpad's Ctrl-scroll and anything on macOS never ask (Chromium leaves those
// to the page), where ⌘+ / ⌘− are the way.

import { app, type WebContents } from "electron";

import type { Shell } from "./shell";
import { nextZoom, readSavedZoom, saveZoom, type ZoomStep } from "./zoom";

let kept: number | null = null;
const keptZoom = () => (kept ??= readSavedZoom(app.getPath("userData")));

/** Is `wc` showing the app itself — the main window or a conversation's own, the
 *  only pages whose size is kept (they share it: one site, one size)? Not the
 *  offline page, not a site on a tab, not a sign-in popup (a third party's). */
const showsApp = (shell: Shell, wc: WebContents) => {
  try {
    return new URL(wc.getURL()).origin === shell.cfg.webOrigin;
  } catch {
    return false;
  }
};

/** One step of zoom on `wc` (the menu's ⌘+ / ⌘− / ⌘0, the wheel). */
export function zoomPage(shell: Shell, wc: WebContents, step: ZoomStep): void {
  if (wc.isDestroyed()) return;
  const f = nextZoom(wc.getZoomFactor(), step);
  wc.setZoomFactor(f);
  if (showsApp(shell, wc) && f !== keptZoom()) {
    kept = f;
    saveZoom(app.getPath("userData"), f);
  }
}

/** Ctrl + the wheel zooms `wc` (the page, a popup) a step at a time. */
export function zoomOnWheel(shell: Shell, wc: WebContents): void {
  wc.on("zoom-changed", (_e, direction) => zoomPage(shell, wc, direction === "in" ? "in" : "out"));
}

/** The app opens at the size it was left at: set again on each new document of
 *  the app — Electron holds a site's size only for as long as it runs. */
export function restoreZoom(shell: Shell, page: WebContents): void {
  page.on("did-navigate", () => {
    if (!showsApp(shell, page)) return;
    const f = keptZoom();
    if (Math.abs(page.getZoomFactor() - f) > 0.001) page.setZoomFactor(f);
  });
}
