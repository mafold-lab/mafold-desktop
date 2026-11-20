// The light / dark picked in the app (Settings ▸ Appearance), kept across
// launches. The page tells the shell each time it applies a theme (bridge.ts
// `setAppearance`), but only once it has loaded; restored from here before the
// window exists (index.ts), the window's ground (window.ts) and the page's
// `prefers-color-scheme` are in it from the first frame — not the system's for
// a moment and then the app's. Pure except for the file read/write at the
// edges, like windowState.ts. Both ends hand over the userData directory.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./log";
import { readAppearance } from "./validate";
import type { Appearance } from "../shared/desktopHost.generated";

/** In userData, beside window-state.json. */
const file = (dir: string) => join(dir, "appearance.json");

/** What was saved; nothing saved, or nothing readable, follows the system. */
export function readSavedAppearance(dir: string): Appearance {
  try {
    return readAppearance((JSON.parse(readFileSync(file(dir), "utf8")) as { mode?: unknown } | null)?.mode) ?? "system";
  } catch {
    return "system";
  }
}

export function saveAppearance(dir: string, mode: Appearance): void {
  try {
    writeFileSync(file(dir), JSON.stringify({ mode }));
  } catch (e) {
    log("could not save the appearance:", e);
  }
}
