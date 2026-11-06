// Page zoom the way Chrome does it: ⌘/Ctrl +, −, 0 and Ctrl + the mouse wheel
// step through Chrome's own ladder of sizes, not by a fixed amount, and the size
// picked for the app is kept across launches (Chrome keeps one per site; the
// window only ever shows the one). Zooming is the page's CSS px growing — the
// page lays itself out again at the narrower width, its breakpoints included
// (frame.ts) — not a picture of it blown up. Pure except for the file
// read/write at the edges, like appearance.ts; pageZoom.ts wires it to Electron.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./log";

/** Chrome's zoom levels (components/zoom/page_zoom_constants.cc). */
export const ZOOM_PRESETS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export type ZoomStep = "in" | "out" | "reset";

/** Chrome's own tolerance for two zoom factors being the same one. */
const SAME = 0.001;

/** The size one step from `factor`: the next preset above or below it — from
 *  a size between two presets, the nearer one that way — and no further than
 *  the ends of the ladder. */
export function nextZoom(factor: number, step: ZoomStep): number {
  if (step === "reset" || !Number.isFinite(factor) || factor <= 0) return 1;
  if (step === "in") return ZOOM_PRESETS.find((p) => p > factor + SAME) ?? ZOOM_PRESETS[ZOOM_PRESETS.length - 1];
  return [...ZOOM_PRESETS].reverse().find((p) => p < factor - SAME) ?? ZOOM_PRESETS[0];
}

/** In userData, beside window-state.json. */
const file = (dir: string) => join(dir, "zoom.json");

const MIN = ZOOM_PRESETS[0];
const MAX = ZOOM_PRESETS[ZOOM_PRESETS.length - 1];

/** What was saved; nothing saved, or nothing readable, is 100%. */
export function readSavedZoom(dir: string): number {
  try {
    const f = (JSON.parse(readFileSync(file(dir), "utf8")) as { factor?: unknown } | null)?.factor;
    return typeof f === "number" && Number.isFinite(f) && f >= MIN && f <= MAX ? f : 1;
  } catch {
    return 1;
  }
}

export function saveZoom(dir: string, factor: number): void {
  try {
    writeFileSync(file(dir), JSON.stringify({ factor }));
  } catch (e) {
    log("could not save the zoom:", e);
  }
}
