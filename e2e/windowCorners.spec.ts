// The window's own corners on macOS (src/main/windowCorners.ts, frame.ts, flag
// `windowCorners`): the window as macOS composites it, on a flat grey, read off
// `screencapture -R`, which takes the region of the screen and so has the
// system's shadow and line in it (`-l`, the window alone, has neither).
//
// The real shell; the corners and the edges are the system's to draw, so
// nothing short of a real window says anything about them.
//
// Sizes are the runner's: its screen is 1x and 1024 wide. Off, the window's
// corners are the system's, a shape macOS doesn't publish (~15pt on 26), which
// is why a sample stands at `CUT`: outside a 30pt corner, inside the system's.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type ElectronApplication } from "@playwright/test";

import { WINDOW_CORNER } from "../src/shared/desktopHost.generated";
import { APP_GROUND } from "../src/shared/appGround.generated";
import { launch, profile, start, startOrigins, startShots, type Launched, type Origins } from "./fixtures";
import { inputAccess, mouse, run, type Rect } from "./os/real";

type Theme = "light" | "dark";

const BACK = 0x7f;
const PAD = 44;
/** Along the diagonal from the corner of the window's bounds: this far in is
 *  outside a 30pt corner, continuous or circle (either curve is 8.8 in), and
 *  inside the system's (4.4). */
const CUT = 6;
/** Past the curve of a 30pt corner. */
const IN = 11;
const SPOT = { x: 120, y: 90, width: 480, height: 480 };
const WEB_DIR = process.env.MAFOLD_DESKTOP_SHOTS_PAGE ?? join(__dirname, "web");

const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

const profileFor = (on: boolean, theme: Theme) =>
  profile({ "appearance.json": JSON.stringify({ mode: theme }), ...(on ? { "window-corners.json": JSON.stringify({ on: true }) } : {}) });

type Globals = { __main: Electron.BaseWindow };

/** The flat grey, behind everything, and the main window kept by name: there
 *  are two windows now, and the shell's lookups say "the first". */
const backdrop = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow, BrowserWindow, screen }, back) => {
    (globalThis as unknown as Globals).__main = BaseWindow.getAllWindows()[0];
    const w = new BrowserWindow({
      ...screen.getPrimaryDisplay().workArea,
      frame: false,
      roundedCorners: false,
      hasShadow: false,
      backgroundColor: back,
      enableLargerThanScreen: true,
    });
    w.setIgnoreMouseEvents(true);
  }, `#${BACK.toString(16).repeat(3)}`);

/** The window at `at`, inside the work area, in front. Returns its bounds. */
const place = (app: ElectronApplication, at: Rect) =>
  app.evaluate(({ app: a, screen }, s) => {
    const w = (globalThis as unknown as Globals).__main;
    const area = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: area.x + s.x, y: area.y + s.y, width: s.width, height: s.height });
    w.show();
    w.moveTop();
    w.focus();
    a.focus({ steal: true });
    return w.getBounds();
  }, at);

const windowBounds = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Globals).__main.getBounds());

/** The fixture page, down to its ground; it has said it's wide, which lets the
 *  window go down to a size that fits on the runner's screen (frame.ts). */
const flatPage = (l: Launched, theme: Theme) =>
  l.page.evaluate((ground) => {
    (window as unknown as { mafoldHost: { setWindowLayout(x: string): void } }).mafoldHost.setWindowLayout("wide");
    document.body.replaceChildren();
    document.documentElement.style.background = ground;
    document.body.style.background = ground;
  }, APP_GROUND[theme]);

async function stage(l: Launched, theme: Theme): Promise<Rect> {
  await flatPage(l, theme);
  await backdrop(l.app);
  const b = await place(l.app, SPOT);
  await settle();
  return b;
}

const hex = (s: string) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));

interface Picture {
  /** The screen at `b`'s window coordinates (negative = outside it). */
  at(x: number, y: number): number[];
  w: number;
  h: number;
}

let dir = "";
let seq = 0;

/** The screen around `b`, in the window's own coordinates. Colours are compared
 *  as greys here: every colour in play is near one, and `toBitmap`'s channel
 *  order is the platform's. */
async function shoot(app: ElectronApplication, b: Rect, name: string): Promise<Picture> {
  const file = join(dir, `${String(++seq).padStart(2, "0")}-${name}.png`);
  const r = await run("screencapture", ["-x", "-R", `${b.x - PAD},${b.y - PAD},${b.width + 2 * PAD},${b.height + 2 * PAD}`, file], { timeoutMs: 20_000 });
  expect(r.code, `screencapture: ${r.err}`).toBe(0);
  const { w, h, data, scale } = await app.evaluate(({ nativeImage }, s) => {
    const img = nativeImage.createFromPath(s.file);
    const { width, height } = img.getSize();
    return { w: width, h: height, data: img.toBitmap().toString("base64"), scale: width / (s.width + 2 * s.pad) };
  }, { file, width: b.width, pad: PAD });
  const px = Buffer.from(data, "base64");
  return {
    w,
    h,
    at: (x, y) => {
      const o = (Math.round((y + PAD) * scale) * w + Math.round((x + PAD) * scale)) * 4;
      return [px[o], px[o + 1], px[o + 2]];
    },
  };
}

const near = (p: number[], c: number[], tol = 4) => p.every((v, i) => Math.abs(v - c[i]) <= tol);
const grey = (v: number) => [v, v, v];

/** The four corners' inward diagonals: `d` along each from the bounds' corner. */
const cornersOf = (b: Rect, d: number) => [
  ["top left", d, d],
  ["top right", b.width - 1 - d, d],
  ["bottom left", d, b.height - 1 - d],
  ["bottom right", b.width - 1 - d, b.height - 1 - d],
] as const;

/** Whether the window fills each corner at `d`, on the given ground. */
const filled = (p: Picture, b: Rect, d: number, ground: number[]) =>
  Object.fromEntries(cornersOf(b, d).map(([name, x, y]) => [name, near(p.at(x, y), ground, 10)]));

const all = (v: boolean) => ({ "top left": v, "top right": v, "bottom left": v, "bottom right": v });

/** Straight edges: the pixel just outside, and the window's first ones. */
const edges = (p: Picture, b: Rect) => {
  const mx = b.width >> 1;
  const my = b.height >> 1;
  return {
    outside: [p.at(-1, my), p.at(b.width, my), p.at(mx, -1), p.at(mx, b.height)],
    inside: [p.at(0, my), p.at(b.width - 1, my), p.at(mx, 0), p.at(mx, b.height - 1), p.at(1, my), p.at(mx, b.height - 2)],
  };
};

/** The system's shadow: darker than the grey on every side, and round the 30pt
 *  shape, not the system's: at CUT there is one, and it isn't the window. */
const expectShadow = (p: Picture, b: Rect) => {
  for (const c of edges(p, b).outside) expect(c[0], `outside ${c}`).toBeLessThan(BACK - 8);
  for (const [name, x, y] of cornersOf(b, CUT)) expect(p.at(x, y)[0], name).toBeLessThan(BACK - 3);
};

/** The line round a dark window: its first pixels are far from its ground. */
const expectLine = (p: Picture, b: Rect, ground: number[]) => {
  for (const c of edges(p, b).inside.slice(0, 4)) expect(near(c, ground, 12), `edge ${c}`).toBe(false);
};

/** What the shell wrote down for its next launch; null before it has. */
function savedCorners(userData: string): boolean | null {
  try {
    return (JSON.parse(readFileSync(join(userData, "window-corners.json"), "utf8")) as { on: boolean }).on;
  } catch {
    return null;
  }
}

const hasSystemShadow = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Globals).__main.hasShadow());
const frameCorners = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __mafoldTest: { frame(): { corners: number; bar: boolean | null } | null } }).__mafoldTest.frame());

let origins: Origins;
let l: Launched | null = null;
const started = (env: Record<string, string>) => launch(origins.web, origins.api, env);

test.skip(process.platform !== "darwin", "the window's own corners are macOS's");

test.beforeAll(async () => {
  origins = await startOrigins();
  dir = join(test.info().project.outputDir, "window-corners");
  mkdirSync(dir, { recursive: true });
});
test.afterAll(async () => {
  await origins.close();
});
test.afterEach(async () => {
  await l?.app.close();
  l = null;
});

test("off: the system's window, its line in dark and its own corners (what the rest of this file is compared to)", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(false, "dark") });
  const b = await stage(l, "dark");
  const ground = hex(APP_GROUND.dark);
  const p = await shoot(l.app, b, "off-dark");
  expect(await hasSystemShadow(l.app)).toBe(true);
  expectLine(p, b, ground);
  // The system's corner is tighter than 30: filled at CUT.
  expect(filled(p, b, CUT, ground)).toEqual(all(true));
  expect((await frameCorners(l.app))?.corners).toBe(0);
});

test("on, dark: 30pt corners, and the system's shadow and its line round them", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "dark") });
  const b = await stage(l, "dark");
  const ground = hex(APP_GROUND.dark);
  const p = await shoot(l.app, b, "on-dark");
  expect(await hasSystemShadow(l.app)).toBe(true);
  expect((await frameCorners(l.app))?.corners).toBe(WINDOW_CORNER);
  expectLine(p, b, ground);
  expectShadow(p, b);
  expect(filled(p, b, CUT, ground)).toEqual(all(false));
  // Top left has the system's lights at IN: the other three say it.
  const f = filled(p, b, IN, ground);
  expect([f["top right"], f["bottom left"], f["bottom right"]]).toEqual([true, true, true]);
});

test("on, light: 30pt corners, and the system's shadow round them", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "light") });
  const b = await stage(l, "light");
  const ground = hex(APP_GROUND.light);
  const p = await shoot(l.app, b, "on-light");
  expect(await hasSystemShadow(l.app)).toBe(true);
  // The rim is there in light too, the colour of the ground.
  for (const c of edges(p, b).inside) expect(near(c, ground), `edge ${c}`).toBe(true);
  expectShadow(p, b);
  expect(filled(p, b, CUT, ground)).toEqual(all(false));
  const f = filled(p, b, IN, ground);
  expect([f["top right"], f["bottom left"], f["bottom right"]]).toEqual([true, true, true]);
});

test("the corner is the system's continuous curve, not a circle", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "light") });
  const b = await stage(l, "light");
  const p = await shoot(l.app, b, "curve");
  // The window's first row, in from its top right corner, away from the lights.
  // A 30pt circle has met the edge 30 in. The continuous curve as big as it meets
  // it 46 in, so at 30 it is still leaving, and the row is a blend of the window
  // and what's behind it. Further in than 22 the two are the same shape.
  const row = Array.from({ length: 30 }, (_, i) => [16 + i, p.at(b.width - 1 - (16 + i), 0)[0]]);
  console.log(`window corners: top row in from the corner: ${JSON.stringify(row)}`);
  const ground = hex(APP_GROUND.light)[0];
  const at = (d: number) => p.at(b.width - 1 - d, 0)[0];
  expect(at(28), "still leaving the edge where a circle has met it").toBeLessThan(ground - 20);
  expect(at(50), "past the curve, the plain edge").toBeGreaterThan(ground - 6);
});

test("the appearance changes under an open window, both ways, and the corners and the shadow stay", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "light") });
  await stage(l, "light");
  const turn = async (theme: Theme, name: string) => {
    await flatPage(l!, theme);
    await l!.page.evaluate((m) => (window as unknown as { mafoldHost: { setAppearance(x: string): void } }).mafoldHost.setAppearance(m), theme);
    await settle();
    const b = await place(l!.app, SPOT);
    await settle();
    const p = await shoot(l!.app, b, name);
    expect(await hasSystemShadow(l!.app)).toBe(true);
    expectShadow(p, b);
    expect(filled(p, b, CUT, hex(APP_GROUND[theme]))).toEqual(all(false));
    return { p, b };
  };

  const dark = await turn("dark", "light-to-dark");
  expectLine(dark.p, dark.b, hex(APP_GROUND.dark));
  const light = await turn("light", "dark-to-light");
  for (const c of edges(light.p, light.b).inside) expect(near(c, hex(APP_GROUND.light)), `edge ${c}`).toBe(true);
});

test("a window resized by the system's own calls stays cut and on its ground, with nothing left where it was", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "light") });
  await stage(l, "light");
  const ground = hex(APP_GROUND.light);
  const b = await place(l.app, { ...SPOT, width: 400 });
  await settle();
  const p = await shoot(l.app, { ...b, width: SPOT.width }, "smaller");
  // Where the right edge was: the grey again.
  expect(near(p.at(b.width + 40, 140), grey(BACK), 12)).toBe(true);
  expect(filled(p, { ...b }, CUT, ground)).toEqual(all(false));
  expect(filled(p, { ...b }, IN, ground)["bottom right"]).toBe(true);
});

test("the phone layout has no chat list to follow: the system's corners, and back", async () => {
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "dark") });
  const b = await stage(l, "dark");
  const ground = hex(APP_GROUND.dark);
  const say = (x: "phone" | "wide") => l!.page.evaluate((v) => (window as unknown as { mafoldHost: { setWindowLayout(x: string): void } }).mafoldHost.setWindowLayout(v), x);

  await say("phone");
  await settle();
  expect(await frameCorners(l.app)).toMatchObject({ corners: 0, bar: true });
  const p = await shoot(l.app, b, "phone");
  const phone = filled(p, b, CUT, ground);
  expect([phone["bottom left"], phone["bottom right"]]).toEqual([true, true]);

  await say("wide");
  await settle();
  expect(await frameCorners(l.app)).toMatchObject({ corners: WINDOW_CORNER, bar: false });
  expect(filled(await shoot(l.app, b, "phone-back"), b, CUT, ground)).toEqual(all(false));
});

test("full screen has no corners, and they come back with the window", async () => {
  test.setTimeout(120_000);
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "dark") });
  await stage(l, "dark");
  const ground = hex(APP_GROUND.dark);
  const full = (on: boolean) =>
    l!.app.evaluate(
      (_e, v) =>
        new Promise<boolean>((done) => {
          const w = (globalThis as unknown as Globals).__main;
          const t = setTimeout(() => done(false), 8000);
          const reached = () => {
            clearTimeout(t);
            done(true);
          };
          if (v) w.once("enter-full-screen", reached);
          else w.once("leave-full-screen", reached);
          w.setFullScreen(v);
        }),
      on,
    );
  expect(await full(true)).toBe(true);
  await settle(1500);
  expect((await frameCorners(l.app))?.corners).toBe(0);
  const screen = await l.app.evaluate(({ screen: s }) => s.getPrimaryDisplay().bounds);
  const file = join(dir, `${String(++seq).padStart(2, "0")}-full-screen.png`);
  expect((await run("screencapture", ["-x", file], { timeoutMs: 20_000 })).code).toBe(0);
  const corners = await l.app.evaluate(({ nativeImage }, f) => {
    const img = nativeImage.createFromPath(f);
    const { width, height } = img.getSize();
    const px = img.toBitmap();
    const at = (x: number, y: number) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
    return [at(3, 3), at(width - 4, 3), at(3, height - 4), at(width - 4, height - 4)];
  }, file);
  for (const c of corners) expect(near(c, ground, 6), `full-screen corner ${c} on ${screen.width}×${screen.height}`).toBe(true);

  expect(await full(false)).toBe(true);
  await settle(1500);
  const back = await place(l.app, SPOT);
  await settle();
  expect((await frameCorners(l.app))?.corners).toBe(WINDOW_CORNER);
  expect(filled(await shoot(l.app, back, "full-screen-back"), back, CUT, ground)).toEqual(all(false));
});

test("the loading cover stands in the same corners", async () => {
  const s = await start(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: profileFor(true, "dark"), MAFOLD_DESKTOP_START_PATH: "/app?slow=15000" });
  try {
    // After the window is built: an evaluate sent before can land inside it (warmup.ts).
    await s.app.firstWindow();
    const coverUp = () => s.app.evaluate(() => (globalThis as unknown as { __mafoldTest?: { coverUp(): boolean } }).__mafoldTest?.coverUp() ?? false);
    await expect.poll(coverUp).toBe(true);
    await backdrop(s.app);
    // The page that would say it's wide, and let the window go down, hasn't come.
    await s.app.evaluate(() => (globalThis as unknown as Globals).__main.setMinimumSize(390, 480));
    const b = await place(s.app, SPOT);
    await settle(1200);
    expect(await coverUp(), "still up for the picture").toBe(true);
    const p = await shoot(s.app, b, "cover");
    expect(filled(p, b, CUT, hex(APP_GROUND.dark))).toEqual(all(false));
    expect(filled(p, b, IN, hex(APP_GROUND.dark))["bottom right"]).toBe(true);
  } finally {
    await s.app.close();
  }
});

test("what the page says is what the next launch makes, and only that", async () => {
  const userData = profileFor(false, "dark");
  l = await started({ MAFOLD_DESKTOP_USER_DATA: userData });
  const tell = (on: boolean) => l!.page.evaluate((v) => (window as unknown as { mafoldHost: { setWindowCorners(v: boolean): void } }).mafoldHost.setWindowCorners(v), on);
  const saved = () => savedCorners(userData);

  await tell(true);
  await expect.poll(saved).toBe(true);
  // This window stays what it was made.
  expect((await frameCorners(l.app))?.corners).toBe(0);

  await l.app.close();
  l = await started({ MAFOLD_DESKTOP_USER_DATA: userData });
  expect((await frameCorners(l.app))?.corners).toBe(WINDOW_CORNER);

  await tell(false);
  await expect.poll(saved).toBe(false);
  await l.app.close();
  l = await started({ MAFOLD_DESKTOP_USER_DATA: userData });
  expect((await frameCorners(l.app))?.corners).toBe(0);
});

test("a real mouse: the visible corner still resizes, and a drag strip still moves the window", async () => {
  test.setTimeout(120_000);
  console.log(`window corners: input access ${await inputAccess()}`);
  l = await started({ MAFOLD_DESKTOP_USER_DATA: profileFor(true, "dark") });
  const b = await stage(l, "dark");
  await l.page.evaluate(() => {
    const d = document.body.appendChild(document.createElement("div"));
    d.style.cssText = "position:fixed;left:60px;right:60px;top:0;height:40px;-webkit-app-region:drag";
    const t = window as unknown as { __moved: boolean };
    t.__moved = false;
    addEventListener("mousemove", () => (t.__moved = true));
  });
  await settle(400);
  // What says the system takes this process's input at all: the page saw a move.
  await mouse(["move", b.x + 200, b.y + 200]);
  await settle(600);
  await mouse(["move", b.x + 210, b.y + 210]);
  await settle(600);
  test.skip(!(await l.page.evaluate(() => (window as unknown as { __moved: boolean }).__moved)), "this runner doesn't let a process post input");
  const results: Record<string, unknown> = {};
  const report = (name: string, before: Rect, after: Rect) => {
    results[name] = { before, after };
    console.log(`window corners: ${name}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  };

  // Where a person takes hold of a rounded corner: on its curve, and short of it
  // and past it, in the part that's cut away.
  for (const [name, d] of [["curve", 9], ["cut away", 4], ["inside", 12], ["bounds", 0]] as const) {
    const before = await place(l.app, SPOT);
    await settle(400);
    const x = before.x + before.width - d;
    const y = before.y + before.height - d;
    await mouse(["drag", x, y, x + 40, y + 30, 300, 12]);
    await settle(500);
    report(`bottom right, ${name}`, before, await windowBounds(l.app));
  }
  for (const [name, d] of [["curve", 9], ["bounds", 0]] as const) {
    const before = await place(l.app, SPOT);
    await settle(400);
    const x = before.x + d;
    const y = before.y + d;
    await mouse(["drag", x, y, x - 40, y - 30, 300, 12]);
    await settle(500);
    report(`top left, ${name}`, before, await windowBounds(l.app));
  }
  {
    const before = await place(l.app, SPOT);
    await settle(400);
    const x = before.x + before.width;
    const y = before.y + (before.height >> 1);
    await mouse(["drag", x, y, x + 50, y, 300, 12]);
    await settle(500);
    report("right edge", before, await windowBounds(l.app));
  }
  const before = await place(l.app, SPOT);
  await settle(400);
  await mouse(["drag", before.x + 240, before.y + 20, before.x + 300, before.y + 60, 400, 12]);
  await settle(500);
  const after = await windowBounds(l.app);
  report("drag strip", before, after);
  expect(after.x - before.x, "the strip moved the window").toBeGreaterThan(30);
  expect(after.width).toBe(before.width);
  const right = results["right edge"] as { before: Rect; after: Rect };
  expect(right.after.width, "a plain edge still resizes").toBeGreaterThan(right.before.width);
  const curve = results["bottom right, curve"] as { before: Rect; after: Rect };
  expect(curve.after.width, "the visible corner resizes").toBeGreaterThan(curve.before.width);
});

// The real web screens in the real window, for a person to look at: the chat
// list's frame against the corners, in both appearances, with the flag as the
// server would give it. The runner's screen is 1024 wide, the web's desktop
// breakpoint, so the window takes the screen's width, and only the shadow's
// sides are off the picture.
test("the real screens: the page tells the shell, the next launch makes the window, the list stands in its corners", async () => {
  test.setTimeout(180_000);
  const shots = await startShots(WEB_DIR);
  test.skip(!shots, `no shots page at ${WEB_DIR}`);
  const screen = (theme: Theme) => `/app?layout=${encodeURIComponent(JSON.stringify({ signedIn: true, chat: true, theme, flags: { windowCorners: true } }))}`;
  const api = "http://127.0.0.1:9";
  try {
    for (const theme of ["dark", "light"] as const) {
      const userData = profileFor(false, theme);
      l = await launch(shots!.web, api, { MAFOLD_DESKTOP_USER_DATA: userData, MAFOLD_DESKTOP_START_PATH: screen(theme) });
      await expect.poll(() => savedCorners(userData)).toBe(true);
      await l.app.close();

      l = await launch(shots!.web, api, { MAFOLD_DESKTOP_USER_DATA: userData, MAFOLD_DESKTOP_START_PATH: screen(theme) });
      await backdrop(l.app);
      await place(l.app, { x: 0, y: 0, width: 1024, height: 660 });
      await settle(2500);
      expect((await frameCorners(l.app))?.corners, "wide at 1024").toBe(WINDOW_CORNER);
      await expect(l.page.locator("[data-testid=list-frame]")).toBeVisible();
      expect((await run("screencapture", ["-x", join(dir, `real-${theme}.png`)], { timeoutMs: 20_000 })).code).toBe(0);
      await l.app.close();
      l = null;
    }
  } finally {
    await shots?.close();
  }
});
