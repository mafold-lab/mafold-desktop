// What the shell keeps per document of the main window — the events the page
// subscribed to, and (macOS) whether the page or the system draws the window's
// lights — must last as long as that document does, and no longer.
//
// It used to be dropped when a navigation STARTED. A file's ↓ (the media
// viewer's: a plain link to an api download) starts one the shell turns into a
// download, and the page never leaves: the system's lights came back on top of
// the page's — two sets — and the page stopped hearing from the shell.
//
// Launched in the tray (`--hidden`): nothing here needs the window in front.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { NATIVE_TRAFFIC_POSITION } from "../src/main/chrome";
import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

const HIDDEN_ARG = "--hidden"; // autostart.ts (which imports electron: not loadable here)

// Click through the DOM: the shell cancels these navigations, and `page.click`
// would wait for them to finish (shell.spec.ts `clickLink`).
const clickLink = (l: Launched, id: string) => l.page.evaluate((i) => (document.getElementById(i) as HTMLAnchorElement).click(), id);

type Hooks = { subscribed(name: string): boolean; emit(name: string, payload?: string): void };
const shell = (l: Launched) => ({
  subscribed: (name: string) => l.app.evaluate((_e, n) => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.subscribed(n), name),
  /** One event from the shell, as it would send it (a deep link is `navigate`). */
  emit: (name: string, payload: string) =>
    l.app.evaluate((_e, [n, p]) => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.emit(n, p), [name, payload] as const),
});
const heard = (l: Launched) => l.page.evaluate(() => (window as unknown as { __events: unknown[] }).__events);

let origins: Origins;
let l: Launched;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.beforeEach(async () => {
  l = await launch(origins.web, origins.api, {}, [HIDDEN_ARG]);
  await l.page.waitForSelector("#h");
});
test.afterEach(async () => {
  await l.app.close();
});

/** Leave by every door that does not replace the page: a download, a link the
 *  system browser gets. Both are done before this returns. */
async function downloadAndHandOff() {
  await clickLink(l, "dl");
  await expect.poll(() => existsSync(join(l.dirs.downloads, "report.txt"))).toBe(true);
  await clickLink(l, "ext");
  await expect.poll(() => l.external().join("\n")).toContain(`${origins.api}/elsewhere`);
  expect(l.page.url()).toBe(`${origins.web}/app`);
}

/** Go to another document of the web app, and wait until it is the one showing. */
async function goTo(search: string) {
  await l.page.evaluate((s) => {
    location.href = `/app?${s}`;
  }, search);
  await l.page.waitForURL(`**/app?${search}`);
  await l.page.waitForSelector("#h");
}

test("a download or a link handed to the browser leaves the page as it was, still listening", async () => {
  const s = shell(l);
  await downloadAndHandOff();
  expect(await s.subscribed("notify-permission")).toBe(true);
  await s.emit("notify-permission", "blocked");
  await s.emit("navigate", "#after-download");
  await expect.poll(() => heard(l)).toEqual([
    ["notify-permission", "blocked"],
    ["navigate", "#after-download"],
  ]);
});

test("a new document starts with nothing: what the page before it listened to is forgotten", async () => {
  const s = shell(l);
  expect(await s.subscribed("navigate")).toBe(true);
  await goTo("quiet"); // listens to nothing
  expect(await s.subscribed("navigate")).toBe(false);
  expect(await s.subscribed("notify-permission")).toBe(false);
  // So a deep link waits for it rather than going nowhere.
  await s.emit("navigate", "#held");
  await l.page.evaluate(() => (window as unknown as { __listen(): void }).__listen());
  await expect.poll(() => heard(l)).toEqual([["navigate", "#held"]]);
});

test("a deep link that arrives while the page is on its way out goes to the page that replaces it", async () => {
  const s = shell(l);
  void l.page.evaluate(() => {
    location.href = "/app?slow"; // takes 1.5 s to arrive
  });
  await expect.poll(() => s.subscribed("navigate")).toBe(true); // the old page, still showing
  await l.page.waitForTimeout(300);
  await s.emit("navigate", "#mid-flight");
  await l.page.waitForURL("**/app?slow");
  await l.page.waitForSelector("#h");
  await expect.poll(() => heard(l)).toEqual([["navigate", "#mid-flight"]]);
});

test("macOS: one set of lights — the system's stay hidden while the page draws its own, until a new document", async () => {
  test.skip(process.platform !== "darwin", "the page draws the window's lights on macOS only");
  // `_getWindowButtonVisibility`: Electron's own (test-only) read of AppKit's
  // close / minimise / zoom buttons — whether any of them is showing.
  // `getWindowButtonPosition`: the slot the shell placed them in
  // (`trafficLightPosition`) — nothing may move it.
  const lights = () =>
    l.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0] as Electron.BrowserWindow & { _getWindowButtonVisibility(): boolean };
      return { system: w._getWindowButtonVisibility(), at: w.getWindowButtonPosition() };
    });
  const drawByPage = () => l.page.evaluate(() => (window as unknown as { mafoldHost: { setWindowControls(d: boolean): void } }).mafoldHost.setWindowControls(true));

  // Nothing drawn yet: the system's stand in, in the pill's slot (chrome.ts).
  const slot = { ...NATIVE_TRAFFIC_POSITION };
  expect(await lights()).toEqual({ system: true, at: slot });

  await drawByPage();
  await expect.poll(lights).toEqual({ system: false, at: slot });

  await downloadAndHandOff();
  expect(await lights()).toEqual({ system: false, at: slot });

  // A new document: back to the system's until it draws.
  await goTo("next");
  await expect.poll(lights).toEqual({ system: true, at: slot });
  await drawByPage();
  await expect.poll(lights).toEqual({ system: false, at: slot });
});
