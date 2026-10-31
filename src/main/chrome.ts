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
//
// Below the web's desktop breakpoint there is no chat-list header for the pill
// to sit in. There the shell draws a title bar of its own above the page —
// the system's lights and the window's title, like the system's own bar
// (frame.ts) — and the page, a bar shorter, draws no lights at all. The
// page says which layout it is in (`window-titlebar`): its breakpoint is in
// CSS px, which page zoom moves away from the window's width.

import { HOST_CAPS, type HostCap } from "../shared/desktopHost.generated";

export type Os = "macos" | "windows" | "linux";

/** The pill slot, in CSS px from the window's top-left (the chat list's header
 *  row: 10 top, 12 left — the web's floating-pill inset). */
export const TRAFFIC_PILL = { top: 10, left: 12, width: 58, height: 44 } as const;

/** Where Electron puts the system's close button (its frame's top-left) when
 *  the page is not drawing the lights: the three ~54×16 buttons centred in the slot. */
export const NATIVE_TRAFFIC_POSITION = { x: TRAFFIC_PILL.left + 2, y: TRAFFIC_PILL.top + TRAFFIC_PILL.height / 2 - 8 } as const;

/** The shell's title bar in the phone layout, as tall as the system's (macOS
 *  26: 31pt and a 1pt line under it), with the system's lights where the
 *  system puts them in its own (their frame's top-left; ~16pt buttons). */
export const TITLE_BAR = { height: 32, lights: { x: 8, y: 8 } } as const;

/** What this shell offers on this OS: drawing the window's own lights — and
 *  the green light's arranging, and the title bar that takes over from them in
 *  the phone layout — is a macOS thing (Windows keeps its native frame). */
const MAC_ONLY: readonly HostCap[] = ["window-controls", "window-arrange", "window-titlebar"];
export const capsFor = (os: Os): HostCap[] => HOST_CAPS.filter((c) => !MAC_ONLY.includes(c) || os === "macos");

export interface Point {
  x: number;
  y: number;
}

/** The window's frame on macOS: whether the shell's title bar shows, where the
 *  page sits under it, and where the system's lights go. The bar shows in the
 *  phone layout out of full screen (full screen has a bar of its own, on hover). */
export function framePlan(at: { layout: "phone" | "wide"; fullscreen: boolean }, size: { width: number; height: number }): { bar: boolean; page: Rect; lights: Point } {
  const bar = at.layout === "phone" && !at.fullscreen;
  const top = bar ? TITLE_BAR.height : 0;
  return {
    bar,
    page: { x: 0, y: top, width: size.width, height: Math.max(0, size.height - top) },
    lights: bar ? { ...TITLE_BAR.lights } : { ...NATIVE_TRAFFIC_POSITION },
  };
}

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
