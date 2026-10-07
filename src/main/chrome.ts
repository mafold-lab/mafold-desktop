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

/** What this shell offers on this OS: drawing the window's own lights is a
 *  macOS thing (Windows keeps its native frame). */
export const capsFor = (os: Os): HostCap[] => HOST_CAPS.filter((c) => c !== "window-controls" || os === "macos");
