// The window's own chrome on macOS: no title bar, and the close / minimise /
// zoom lights drawn by the page where mafold-mac drew them — a 58×44 frosted
// pill, 10pt from the top, three 12pt dots 6pt apart (mafold-mac
// ConversationListViewController RailMetrics.trafficPillWidth /
// TrafficLightButton, Theme.pillTopHeight; the owner tuned those by hand).
// The page draws them (mafold-web components/WindowControls.tsx); the shell
// hides the system's own while it does.
//
// When the page does NOT draw them — the offline page, a page that has not
// loaded yet — the system's lights come back, placed in that same pill slot,
// so the window can always be closed and never looks broken.

import { HOST_CAPS, type HostCap } from "../shared/desktopHost.generated";

export type Os = "macos" | "windows" | "linux";

/** The pill slot, in CSS px from the window's top-left (the chat list's header
 *  row: 10 top, 12 left — the web's floating-pill inset). */
export const TRAFFIC_PILL = { top: 10, left: 12, width: 58, height: 44 } as const;

/** Where Electron puts the system's close button (its frame's top-left) when
 *  the page is not drawing the lights: the three ~54×16 buttons centred in the slot. */
export const NATIVE_TRAFFIC_POSITION = { x: TRAFFIC_PILL.left + 2, y: TRAFFIC_PILL.top + TRAFFIC_PILL.height / 2 - 8 } as const;

/** What this shell offers on this OS: drawing the window's own lights — and
 *  the green light's arranging — is a macOS thing (Windows keeps its native frame). */
const MAC_ONLY: readonly HostCap[] = ["window-controls", "window-arrange"];
export const capsFor = (os: Os): HostCap[] => HOST_CAPS.filter((c) => !MAC_ONLY.includes(c) || os === "macos");

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the green light's move-and-resize menu puts the window, inside the
 *  work area of the display it is on (macOS's Window ▸ Move & Resize). Halves
 *  split the width; an odd pixel goes to the right half so the two meet. */
export function arrangedBounds(action: "fill" | "center" | "tile-left" | "tile-right", area: Rect, current: Rect): Rect {
  const half = Math.floor(area.width / 2);
  switch (action) {
    case "fill":
      return { ...area };
    case "tile-left":
      return { x: area.x, y: area.y, width: half, height: area.height };
    case "tile-right":
      return { x: area.x + half, y: area.y, width: area.width - half, height: area.height };
    case "center": {
      const width = Math.min(current.width, area.width);
      const height = Math.min(current.height, area.height);
      return {
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
        width,
        height,
      };
    }
  }
}
