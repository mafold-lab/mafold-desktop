// Ctrl + the mouse wheel in the real shell, with the system's own wheel
// (os/real.ts): Electron zooms nothing by itself, only the shell can answer it.
// On macOS the wheel doesn't zoom, as in Chrome.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";
import { wheelNotch } from "./os/real";

declare const mafoldHost: { openChatWindow(c: string): void };

const CONV = "11111111-1111-4111-8111-111111111111";

test.skip(process.platform === "darwin", "Chrome's wheel doesn't zoom on macOS either");

let origins: Origins;
let l: Launched;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.beforeEach(async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
});
test.afterEach(async () => {
  await l?.app.close();
});

/** One notch of the wheel over the middle of `p`'s window, Ctrl held unless said. */
async function notch(p: Page, ticks: 1 | -1, ctrl = true) {
  const at = await l.app.evaluate(({ BaseWindow, BrowserWindow, screen, webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    const w = (wc && BrowserWindow.fromWebContents(wc)) ?? BaseWindow.getAllWindows()[0];
    const b = w.getContentBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, scale: screen.getDisplayMatching(b).scaleFactor };
  }, p.url());
  expect(await wheelNotch(at.x, at.y, ticks, ctrl, at.scale)).toEqual({ ok: true });
}
const sizeOf = (p: Page) =>
  l.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)?.getZoomFactor(), p.url());
const kept = () => JSON.parse(readFileSync(join(l.dirs.userData, "zoom.json"), "utf8")).factor as number;

test("each notch is a step of Chrome's ladder, and the page lays itself out again", async () => {
  const width = await l.page.evaluate(() => innerWidth);
  await notch(l.page, 1);
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(1.1);
  await notch(l.page, 1);
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(1.25);
  await expect.poll(() => l.page.evaluate(() => innerWidth)).toBeLessThan(width);
  await notch(l.page, -1);
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(1.1);
  await notch(l.page, -1);
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(1);
  await notch(l.page, -1);
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(0.9);
});

test("without Ctrl the wheel only scrolls", async () => {
  await notch(l.page, 1, false);
  await l.page.waitForTimeout(300);
  expect(await sizeOf(l.page)).toBe(1);
});

test("a conversation's own window zooms too, and it's the size the app keeps", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), CONV);
  await expect.poll(() => l.app.windows().some((p) => p.url().endsWith(`#${CONV}`))).toBe(true);
  const solo = l.app.windows().find((p) => p.url().endsWith(`#${CONV}`))!;
  await solo.waitForSelector("#h");
  await notch(solo, 1);
  await expect.poll(() => sizeOf(solo)).toBeCloseTo(1.1);
  expect(kept()).toBeCloseTo(1.1);
});

test("the size is there when Mafold starts again", async () => {
  await notch(l.page, 1);
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(1.1);
  await expect.poll(kept).toBeCloseTo(1.1);
  const userData = l.dirs.userData;
  await l.app.close();
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: userData });
  await l.page.waitForSelector("#h");
  await expect.poll(() => sizeOf(l.page)).toBeCloseTo(1.1);
});
