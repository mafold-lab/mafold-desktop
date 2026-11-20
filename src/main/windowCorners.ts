// The window's own corners (flag `windowCorners`, macOS; ops 11-07: the four
// corners follow the chat list's, in the system's continuous curve, not a
// circle). The system's corners have no setting, so the window is made
// see-through and cut as a whole (native/windowCut.m, frame.ts). See-through is
// decided when a window is made, so the flag can't reach one that exists: the
// page says what it reads on every load (bridge.ts `setWindowCorners`), and the
// next launch makes that window. Off, nothing saved, or a cut that won't load
// is the system's.
//
// The line round a dark window stays, on purpose. It is part of the system's
// shadow, not of the window: the window server draws both, round whatever shape
// the window has, over its pixels (real macOS 26, CI 11-07: a rim of #49494b on
// a #1C1C1E window with a shadow, on any corners; none without). Losing the line
// means losing the shadow, and ops 11-07 kept the shadow.
//
// Pure except for the file read/write and the native module at the edges, like
// appearance.ts. Both ends of the file hand over the userData directory.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseWindow } from "electron";

import { log } from "./log";

/** In userData, beside window-state.json. */
const file = (dir: string) => join(dir, "window-corners.json");

/** A see-through window's background: what shows in the cut corners. */
export const CLEAR = "#00000000";

/** Cuts a whole window to a corner, in points; 0 leaves the system's. */
export type WindowCut = (win: BaseWindow, corner: number) => void;

/** The cut (native/windowCut.m), or null if it won't load: a window with no cut
 *  to make is an ordinary one, not a see-through one with no corners. */
export function windowCut(): WindowCut | null {
  const native = { exports: {} as { cut(handle: Buffer, radius: number): boolean } };
  try {
    process.dlopen(native, join(__dirname, "..", "native", "windowCut.node"));
  } catch (e) {
    log("the window's corner cut did not load:", e);
    return null;
  }
  log("the window's corner cut is loaded");
  return (win, corner) => {
    if (!native.exports.cut(win.getNativeWindowHandle(), corner)) log("the window has no layer to cut");
  };
}

export function readWindowCorners(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(file(dir), "utf8")) as { on?: unknown } | null)?.on === true;
  } catch {
    return false;
  }
}

export function saveWindowCorners(dir: string, on: boolean): void {
  try {
    writeFileSync(file(dir), JSON.stringify({ on }));
  } catch (e) {
    log("could not save the window's corners:", e);
  }
}
