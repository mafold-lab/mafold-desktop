import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cascadedBounds, droppedBounds, readChatWindows, remembered, writeChatWindows, type SavedChatWindow } from "../src/main/chatWindowPlan";

const area = { x: 1920, y: 0, width: 2560, height: 1400 };
const size = { width: 420, height: 680 };
const saved = (conv: string, open = true): SavedChatWindow => ({ conv, bounds: { x: 1, y: 2, width: 420, height: 680 }, open });

describe("droppedBounds", () => {
  it("puts the title bar under the cursor, on the display it was dropped on", () => {
    expect(droppedBounds({ x: 3000, y: 300 }, size, area)).toEqual({ x: 2790, y: 284, width: 420, height: 680 });
  });
  it("keeps the whole window on that display at its edges", () => {
    expect(droppedBounds({ x: 4470, y: 1390 }, size, area)).toEqual({ x: 4060, y: 720, width: 420, height: 680 });
    expect(droppedBounds({ x: 1925, y: 2 }, size, area)).toEqual({ x: 1920, y: 0, width: 420, height: 680 });
  });
  it("shrinks to a display smaller than the window", () => {
    expect(droppedBounds({ x: 100, y: 100 }, size, { x: 0, y: 0, width: 400, height: 500 })).toEqual({ x: 0, y: 0, width: 400, height: 500 });
  });
});

describe("cascadedBounds", () => {
  it("steps on from the main window for each one open", () => {
    const main = { x: 100, y: 50, width: 1240, height: 820 };
    const screen = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(cascadedBounds(main, 0, size, screen)).toMatchObject({ x: 132, y: 82 });
    expect(cascadedBounds(main, 2, size, screen)).toMatchObject({ x: 196, y: 146 });
  });
});

describe("saved windows", () => {
  it("keeps one entry for a conversation, the latest first", () => {
    const list = remembered([saved("a"), saved("b")], saved("b", false));
    expect(list.map((s) => [s.conv, s.open])).toEqual([["b", false], ["a", true]]);
  });
  it("forgets the oldest past what it keeps", () => {
    let list: SavedChatWindow[] = [];
    for (let i = 0; i < 70; i++) list = remembered(list, saved(`c${i}`));
    expect(list).toHaveLength(64);
    expect(list[0].conv).toBe("c69");
  });
  it("reads back what it wrote, and nothing from a bad file", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-windows-"));
    const file = join(dir, "w.json");
    writeChatWindows(file, [saved("a")]);
    expect(readChatWindows(file)).toEqual([saved("a")]);
    writeFileSync(file, JSON.stringify([{ conv: "a" }, saved("b")]));
    expect(readChatWindows(file).map((s) => s.conv)).toEqual(["b"]);
    writeFileSync(file, "not json");
    expect(readChatWindows(file)).toEqual([]);
    expect(readChatWindows(join(dir, "missing"))).toEqual([]);
  });
});
