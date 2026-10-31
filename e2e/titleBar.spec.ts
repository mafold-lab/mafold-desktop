// The phone layout's title bar on macOS (src/main/frame.ts): a page that
// says it is in the phone layout gets the shell's bar above it — the system's
// lights in it — and a window a bar shorter; one that says wide gets the page
// to the top edge again. Saying anything lowers the window's minimum to a
// phone's. A page that draws its lights without saying — a web older than the
// bar — gets the wide frame and the 1024 minimum back, however the window was
// left. What the bar looks like, and real input on it, is phoneWidth.spec's.
//
// Launched in the tray (`--hidden`) where only the frame is looked at: a page
// put away with its window keeps the size it had (window.ts hides its view),
// so the one that reads the page's own viewport opens the window.

import { expect, test, type ElectronApplication } from "@playwright/test";

import { NATIVE_TRAFFIC_POSITION, TITLE_BAR } from "../src/main/chrome";
import { launch, profile, startOrigins, type Launched, type Origins } from "./fixtures";

const HIDDEN_ARG = "--hidden"; // autostart.ts (which imports electron: not loadable here)

type Frame = { bar: boolean | null; page: { x: number; y: number; width: number; height: number } | null; min: number[]; lights: { x: number; y: number } | null };
const frame = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __mafoldTest: { frame(): Frame | null } }).__mafoldTest.frame());

const contentSize = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentSize());

const resize = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(({ BaseWindow }, [w, h]) => BaseWindow.getAllWindows()[0].setContentSize(w, h), [width, height] as const);

type Host = { setWindowLayout?(l: string): void; setWindowControls(d: boolean): void };
const say = (l: Launched, layout: "phone" | "wide") => l.page.evaluate((x) => (window as unknown as { mafoldHost: Host }).mafoldHost.setWindowLayout!(x), layout);
const drawLights = (l: Launched, drawn: boolean) => l.page.evaluate((d) => (window as unknown as { mafoldHost: Host }).mafoldHost.setWindowControls(d), drawn);

/** The page's own viewport, as it lays itself out. */
const viewport = (l: Launched) => l.page.evaluate(() => [innerWidth, innerHeight]);

/** The bar's web contents: a static data: document (a drag region and the
 *  title), one of them, whatever the layout did before. */
const barContents = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) => {
    const page = (globalThis as unknown as { __mafoldTest: { page(): Electron.WebContents } }).__mafoldTest.page();
    return webContents.getAllWebContents().filter((w) => w !== page && w.getURL().startsWith("data:text/html") && w.getURL().includes("app-region")).length;
  });

let origins: Origins;
let l: Launched | null = null;

test.skip(process.platform !== "darwin", "the shell draws a title bar of its own on macOS only");

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.afterEach(async () => {
  await l?.app.close();
  l = null;
});

test("phone layout: the shell's bar above the page, the system's lights in it; wide: the page to the top again", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  const { app } = l;

  // A window that has only been wide, and a page that has said nothing: as before.
  const [w0, h0] = await contentSize(app);
  expect(await frame(app)).toEqual({ bar: false, page: { x: 0, y: 0, width: w0, height: h0 }, min: [1024, 620], lights: NATIVE_TRAFFIC_POSITION });

  // A page that knows the bar: the window may go down to a phone's width.
  await say(l, "wide");
  await expect.poll(async () => (await frame(app))!.min).toEqual([390, 480]);
  expect((await frame(app))!.bar).toBe(false);

  // Sizes a small screen holds (a CI Mac's is 1024×677): a shown window is
  // kept on it, so what it got is read back rather than assumed.
  await resize(app, 390, 600);
  await say(l, "phone");
  await expect.poll(async () => (await frame(app))!.bar).toBe(true);
  const [w, h] = await contentSize(app);
  expect(w).toBe(390);
  expect(await frame(app)).toEqual({ bar: true, page: { x: 0, y: TITLE_BAR.height, width: w, height: h - TITLE_BAR.height }, min: [390, 480], lights: TITLE_BAR.lights });
  // The page really is a bar shorter: nothing of it is under the bar.
  await expect.poll(() => viewport(l!)).toEqual([w, h - TITLE_BAR.height]);
  // One bar: a static document (no script, no preload — frame.ts), once its
  // own renderer has it.
  await expect.poll(() => barContents(app)).toBe(1);

  // The window grows and shrinks: the page under the bar follows.
  await resize(app, 600, 560);
  const [w2, h2] = await contentSize(app);
  await expect.poll(async () => (await frame(app))!.page).toEqual({ x: 0, y: TITLE_BAR.height, width: w2, height: h2 - TITLE_BAR.height });

  // Wide again: no bar, the page to the top edge, the lights back in the pill's slot.
  await resize(app, 1240, 600);
  await say(l, "wide");
  await expect.poll(async () => (await frame(app))!.bar).toBe(false);
  const [w3, h3] = await contentSize(app);
  expect(await frame(app)).toEqual({ bar: false, page: { x: 0, y: 0, width: w3, height: h3 }, min: [390, 480], lights: NATIVE_TRAFFIC_POSITION });
  await expect.poll(() => viewport(l!)).toEqual([w3, h3]);

  // Phone once more: the same bar comes back, not a second one.
  await resize(app, 390, 600);
  await say(l, "phone");
  await expect.poll(async () => (await frame(app))!.bar).toBe(true);
  expect(await barContents(app)).toBe(1);
});

test("a reload keeps the frame: a new document has said nothing yet, and nothing jumps", async () => {
  l = await launch(origins.web, origins.api, {}, [HIDDEN_ARG]);
  await l.page.waitForSelector("#h");
  const { app } = l;
  await say(l, "wide");
  await resize(app, 390, 700);
  await say(l, "phone");
  await expect.poll(async () => (await frame(app))!.bar).toBe(true);

  await l.page.reload();
  await l.page.waitForSelector("#h");
  expect(await frame(app)).toEqual({ bar: true, page: { x: 0, y: TITLE_BAR.height, width: 390, height: 700 - TITLE_BAR.height }, min: [390, 480], lights: TITLE_BAR.lights });
  // The new document says it is in the phone layout too: still one bar, nothing moved.
  await say(l, "phone");
  await drawLights(l, false);
  expect(await frame(app)).toEqual({ bar: true, page: { x: 0, y: TITLE_BAR.height, width: 390, height: 700 - TITLE_BAR.height }, min: [390, 480], lights: TITLE_BAR.lights });
  await expect.poll(() => barContents(app)).toBe(1);
});

test("a page that draws its lights without saying its layout — an older web — gets no bar, and the window back to 1024", async () => {
  // A window left at a phone's width (a page that knew the bar let it get there).
  const userData = profile({ "window-state.json": JSON.stringify({ bounds: { x: 40, y: 60, width: 390, height: 700 }, maximized: false }) });
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: userData }, [HIDDEN_ARG]);
  await l.page.waitForSelector("#h");
  const { app } = l;

  // It opens as it was left: narrow, the bar up, until the page says.
  expect(await contentSize(app)).toEqual([390, 700]);
  expect(await frame(app)).toEqual({ bar: true, page: { x: 0, y: TITLE_BAR.height, width: 390, height: 700 - TITLE_BAR.height }, min: [390, 480], lights: TITLE_BAR.lights });

  // This page draws the lights itself, at every width: the wide frame for it.
  await drawLights(l, true);
  await expect.poll(async () => (await frame(app))!.bar).toBe(false);
  const f = (await frame(app))!;
  expect(f.min).toEqual([1024, 620]);
  expect(f.lights).toEqual(NATIVE_TRAFFIC_POSITION);
  const [w, h] = await contentSize(app);
  expect(w).toBeGreaterThanOrEqual(1024);
  expect(f.page).toEqual({ x: 0, y: 0, width: w, height: h });
});
