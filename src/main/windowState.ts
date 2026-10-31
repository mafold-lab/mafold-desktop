// Where the window was, so it opens there again. Pure except for the file
// read/write at the edges; `fit` is what keeps a window saved on a monitor that
// has since been unplugged from opening off-screen.

import { readFileSync, writeFileSync } from "node:fs";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  bounds: Bounds;
  maximized: boolean;
}

/** mafold-mac's window opens at 1240×820. */
export const DEFAULT_SIZE = { width: 1240, height: 820 };
/** Down to a phone's width: the web's phone layout fits it. */
export const MIN_SIZE = { width: 390, height: 480 };
/** On macOS a page that draws the window's lights at every width — one that
 *  does not know the shell's title bar (chrome.ts), a web older than it — has
 *  them at the head of the chat list, so for it the window stays at least as
 *  wide as the web's desktop breakpoint (useIsDesktop, 1024): the layout
 *  where that list is always on screen. mafold-mac's own minimum was 940×620. */
export const MAC_MIN_SIZE = { width: 1024, height: 620 };

/** The minimum a window opens with. On macOS that is MAC_MIN_SIZE until the
 *  page says it knows the title bar (frame.ts lowers it then) — unless the
 *  window was left narrower than that, which only a page that knew it allowed. */
export const minSizeFor = (os: "macos" | "windows" | "linux", saved: SavedWindow | null = null) =>
  os !== "macos" || (saved && saved.bounds.width < MAC_MIN_SIZE.width) ? MIN_SIZE : MAC_MIN_SIZE;

const isBounds = (b: unknown): b is Bounds =>
  !!b && typeof b === "object" && ["x", "y", "width", "height"].every((k) => Number.isFinite((b as Record<string, unknown>)[k]));

export function readSaved(file: string): SavedWindow | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedWindow>;
    return isBounds(v.bounds) ? { bounds: v.bounds, maximized: !!v.maximized } : null;
  } catch {
    return null;
  }
}

export function writeSaved(file: string, s: SavedWindow): void {
  try {
    writeFileSync(file, JSON.stringify(s));
  } catch {
    /* not worth failing anything over */
  }
}

/**
 * The saved bounds if at least a usable corner of them is on one of the
 * displays' work areas; otherwise the default size, centred by the caller.
 */
export function fit(
  saved: SavedWindow | null,
  workAreas: Bounds[],
  min: { width: number; height: number } = MIN_SIZE,
): (Bounds & { maximized: boolean }) | null {
  if (!saved) return null;
  const b = {
    ...saved.bounds,
    width: Math.max(min.width, Math.round(saved.bounds.width)),
    height: Math.max(min.height, Math.round(saved.bounds.height)),
  };
  const GRAB = 80; // enough of the title area to drag it back
  const visible = workAreas.some(
    (a) => b.x + GRAB <= a.x + a.width && b.x + b.width - GRAB >= a.x && b.y >= a.y - 10 && b.y + GRAB <= a.y + a.height,
  );
  return visible ? { ...b, maximized: saved.maximized } : null;
}
