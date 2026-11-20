// Where a conversation's own window goes, and what is written down about them.
// Pure except for the file read/write at the edges, like windowState.ts;
// test/chatWindowPlan.spec.ts covers it.

import { readFileSync, writeFileSync } from "node:fs";

import type { Point } from "./chrome";
import type { Bounds } from "./windowState";

/** In userData, beside window-state.json. */
export const CHAT_WINDOWS_FILE = "chat-windows.json";
/** One channel's window: a phone's proportions, what the web's phone layout is
 *  drawn for. */
export const CHAT_WINDOW_SIZE = { width: 420, height: 680 };
/** A whole conversation's window: that and its channels' column beside it. */
export const CONV_WINDOW_SIZE = { width: 760, height: 680 };
/** How many windows' places are kept; the oldest are forgotten. */
const KEPT = 64;
/** Each window opened with nowhere to be sits this much on from the last. */
const CASCADE = 32;
/** The cursor stays on the title bar of a window dropped under it. */
const GRAB_Y = 16;

/** What a window shows: a whole conversation, or `channel` of it alone. */
export interface ChatTarget {
  conv: string;
  channel?: string;
}

export const chatWindowKey = (t: ChatTarget): string => (t.channel ? `${t.conv}/${t.channel}` : t.conv);

export interface SavedChatWindow extends ChatTarget {
  bounds: Bounds;
  /** Open when it was written: it comes back with the next launch. */
  open: boolean;
}

const isSaved = (v: unknown): v is SavedChatWindow => {
  const o = v as SavedChatWindow | null;
  return !!o && typeof o.conv === "string" && (o.channel === undefined || typeof o.channel === "string") && typeof o.open === "boolean" && ["x", "y", "width", "height"].every((k) => Number.isFinite(o.bounds?.[k as keyof Bounds]));
};

export function readChatWindows(file: string): SavedChatWindow[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(v) ? v.filter(isSaved) : [];
  } catch {
    return [];
  }
}

export function writeChatWindows(file: string, saved: SavedChatWindow[]): void {
  try {
    writeFileSync(file, JSON.stringify(saved));
  } catch {
    /* not worth failing anything over */
  }
}

/** `entry` first, in place of what was known about its window. */
export const remembered = (saved: SavedChatWindow[], entry: SavedChatWindow): SavedChatWindow[] =>
  [entry, ...saved.filter((s) => chatWindowKey(s) !== chatWindowKey(entry))].slice(0, KEPT);

const within = (start: number, size: number, from: number, length: number) => Math.round(Math.max(from, Math.min(start, from + length - size)));

function inside(b: Bounds, area: Bounds): Bounds {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  return { x: within(b.x, width, area.x, area.width), y: within(b.y, height, area.y, area.height), width, height };
}

/** Under the cursor where the row was dropped, its title bar in hand, whole on
 *  that display. */
export const droppedBounds = (cursor: Point, size: { width: number; height: number }, area: Bounds): Bounds =>
  inside({ x: cursor.x - size.width / 2, y: cursor.y - GRAB_Y, width: size.width, height: size.height }, area);

/** Beside the main window's corner, each next one a step on. */
export const cascadedBounds = (main: Bounds, open: number, size: { width: number; height: number }, area: Bounds): Bounds =>
  inside({ x: main.x + CASCADE * (open + 1), y: main.y + CASCADE * (open + 1), width: size.width, height: size.height }, area);
