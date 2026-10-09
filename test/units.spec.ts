import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { resolveConfig, PRODUCTION } from "../src/main/config";
import { Strings } from "../src/main/i18n";
import { clip, RateLimit, uniqueName } from "../src/main/limits";
import { badgePng, badgeText, encodePng, renderBadge } from "../src/main/png";
import { fit, MIN_SIZE, minSizeFor } from "../src/main/windowState";
import { arrangedBounds, capsFor, NATIVE_TRAFFIC_POSITION, TRAFFIC_PILL } from "../src/main/chrome";

describe("resolveConfig", () => {
  it("ignores the environment entirely when packaged", () => {
    const c = resolveConfig({ MAFOLD_DESKTOP_WEB: "http://evil.test", MAFOLD_DESKTOP_USER_DATA: "/tmp/x" }, true);
    expect(c).toEqual({ ...PRODUCTION, test: null });
  });
  it("takes a local web and api when unpackaged, and never updates", () => {
    const c = resolveConfig({ MAFOLD_DESKTOP_WEB: "http://127.0.0.1:5000/whatever", MAFOLD_DESKTOP_API: "http://127.0.0.1:5001" }, false);
    expect(c.webOrigin).toBe("http://127.0.0.1:5000");
    expect(c.startUrl).toBe("http://127.0.0.1:5000/app");
    expect(c.apiOrigin).toBe("http://127.0.0.1:5001");
    expect(c.updateFeed).toBeNull();
  });
  it("refuses a non-web origin", () => {
    expect(() => resolveConfig({ MAFOLD_DESKTOP_WEB: "file:///x" }, false)).toThrow();
  });
});

describe("Strings", () => {
  const table = {
    en: { "desktop.a": "Hello {name}", "desktop.b": "B" },
    "zh-Hans": { "desktop.a": "你好 {name}", "desktop.b": "乙" },
  };
  it("picks the pack from the OS locale", () => {
    expect(new Strings(table, "zh-CN").language).toBe("zh-Hans");
    expect(new Strings(table, "zh-TW").language).toBe("zh-Hans");
    expect(new Strings(table, "en-GB").language).toBe("en");
    expect(new Strings(table, "fr-FR").language).toBe("en");
  });
  it("fills variables", () => {
    expect(new Strings(table, "en").t("desktop.a", { name: "Ada" })).toBe("Hello Ada");
  });
  it("follows the page for t(), never for frozen()", () => {
    const s = new Strings(table, "en");
    s.setLocale("zh-Hans", { "desktop.b": "page wording", "desktop.unknown": "x", "desktop.a": 5 });
    expect(s.t("desktop.b")).toBe("page wording");
    expect(s.frozen("desktop.b")).toBe("乙");
    expect(s.t("desktop.a", { name: "A" })).toBe("你好 A");
    expect(s.t("desktop.unknown")).toBe("desktop.unknown");
  });
});

describe("limits", () => {
  it("rate-limits per key", () => {
    const r = new RateLimit(1000);
    expect(r.allow("a", 0)).toBe(true);
    expect(r.allow("a", 500)).toBe(false);
    expect(r.allow("b", 500)).toBe(true);
    expect(r.allow("a", 1000)).toBe(true);
  });
  it("finds a free file name and strips path tricks", () => {
    const taken = new Set(["a.pdf", "a (1).pdf", "noext"]);
    expect(uniqueName("a.pdf", (n) => taken.has(n))).toBe("a (2).pdf");
    expect(uniqueName("noext", (n) => taken.has(n))).toBe("noext (1)");
    expect(uniqueName("../../etc/passwd", () => false)).toBe("__.._etc_passwd");
    expect(uniqueName("..\\..\\x.exe", () => false)).toBe("__.._x.exe");
    expect(uniqueName("", () => false)).toBe("download");
  });
  it("clips", () => {
    expect(clip("abcdef", 3)).toBe("abc");
    expect(clip(42, 3)).toBe("");
  });
});

describe("badge png", () => {
  it("says the count, then 9+", () => {
    expect([0, -1, NaN, 1, 9, 10, 500].map(badgeText)).toEqual(["", "", "", "1", "9", "9+", "9+"]);
    expect(badgePng(0)).toBeNull();
  });
  it("encodes a valid PNG of the right size", () => {
    const png = badgePng(3, 32)!;
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(32); // IHDR width
    expect(png.readUInt32BE(20)).toBe(32); // IHDR height
    // IDAT round-trips to one filter byte + 32 RGBA pixels per row.
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(32 * (32 * 4 + 1));
  });
  it("draws white ink in the middle and leaves the corners clear", () => {
    const px = renderBadge("8", 32);
    const at = (x: number, y: number) => px.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4);
    expect(at(0, 0)[3]).toBe(0);
    expect([...at(16, 16)].slice(0, 3)).toEqual([255, 255, 255]);
  });
  it("rejects a mismatched buffer", () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });
});

describe("window placement", () => {
  const screen = [{ x: 0, y: 0, width: 1440, height: 900 }];
  it("restores a window that is on screen", () => {
    expect(fit({ bounds: { x: 100, y: 100, width: 1000, height: 700 }, maximized: true }, screen)).toEqual({
      x: 100, y: 100, width: 1000, height: 700, maximized: true,
    });
  });
  it("drops a window left on an unplugged monitor", () => {
    expect(fit({ bounds: { x: 3000, y: 100, width: 1000, height: 700 }, maximized: false }, screen)).toBeNull();
  });
  it("never restores below the minimum size", () => {
    const r = fit({ bounds: { x: 10, y: 10, width: 100, height: 100 }, maximized: false }, screen)!;
    expect([r.width, r.height]).toEqual([MIN_SIZE.width, MIN_SIZE.height]);
  });
  it("on macOS, never below the web's desktop breakpoint — where the lights live", () => {
    const r = fit({ bounds: { x: 10, y: 10, width: 800, height: 500 }, maximized: false }, screen, minSizeFor("macos"))!;
    expect([r.width, r.height]).toEqual([1024, 620]);
    expect(minSizeFor("windows")).toBe(MIN_SIZE);
  });
});

describe("window chrome (macOS)", () => {
  it("offers drawing the lights on macOS only", () => {
    expect(capsFor("macos")).toContain("window-controls");
    expect(capsFor("windows")).not.toContain("window-controls");
    expect(capsFor("linux")).not.toContain("window-controls");
    expect(capsFor("windows")).toContain("daemon");
    // The green light's arranging travels with the drawn lights.
    expect(capsFor("macos")).toContain("window-arrange");
    expect(capsFor("windows")).not.toContain("window-arrange");
  });
  it("arranges the window inside the display's work area", () => {
    const area = { x: 0, y: 25, width: 1513, height: 957 };
    const cur = { x: 300, y: 200, width: 1100, height: 700 };
    expect(arrangedBounds("fill", area, cur)).toEqual(area);
    const left = arrangedBounds("tile-left", area, cur);
    const right = arrangedBounds("tile-right", area, cur);
    expect(left).toEqual({ x: 0, y: 25, width: 756, height: 957 });
    // the odd pixel goes right, and the halves meet with no gap or overlap
    expect(right).toEqual({ x: 756, y: 25, width: 757, height: 957 });
    expect(left.x + left.width).toBe(right.x);
    expect(arrangedBounds("center", area, cur)).toEqual({ x: 207, y: 154, width: 1100, height: 700 });
    // a window bigger than the area is clamped to it
    expect(arrangedBounds("center", area, { x: 0, y: 0, width: 4000, height: 3000 })).toEqual(area);
    // a second display to the left (negative x) keeps its own origin
    expect(arrangedBounds("tile-right", { x: -1920, y: 0, width: 1920, height: 1055 }, cur)).toEqual({ x: -960, y: 0, width: 960, height: 1055 });
  });
  it("puts the system's lights inside mafold-mac's pill slot", () => {
    // the three buttons span ~54×16 from this corner
    expect(NATIVE_TRAFFIC_POSITION.x).toBeGreaterThanOrEqual(TRAFFIC_PILL.left);
    expect(NATIVE_TRAFFIC_POSITION.x + 54).toBeLessThanOrEqual(TRAFFIC_PILL.left + TRAFFIC_PILL.width);
    expect(NATIVE_TRAFFIC_POSITION.y + 8).toBe(TRAFFIC_PILL.top + TRAFFIC_PILL.height / 2);
  });
});
