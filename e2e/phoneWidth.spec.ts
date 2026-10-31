// The window from wide down to phone width, photographed by the OS. On macOS,
// from the web's desktop breakpoint up, the page runs to the window's top edge
// and draws the lights at the head of its chat list, as it always has; below
// it, the shell draws a title bar of its own above the page — the system's
// lights and the window's title — and the page, a bar shorter, draws no window
// chrome at all, so no screen of it has to make room for any (frame.ts,
// chrome.ts). Windows and Linux keep the system's frame at every width. The
// window goes down to 390×480 on every OS (windowState.ts; on macOS once the
// page says it knows the bar). The real shell, the real web screens: the page is
// mafold-web's window-lights harness with the English pack
// (mafold-web/test/windowLights/shots.tsx), which the monorepo's dispatch job
// builds and push-tree.sh copies in as e2e/web/ — this tree alone has no web
// app, so without that copy the whole file is skipped.
//
// For a person to look at, mostly: in light at 1440×900, 1024×720, 700×820
// and 390×844, and the same in dark (Settings ▸ Appearance ▸ Dark), it takes the chat list, a chat, Settings (the list, a section, My
// Profile), New Chat, a confirm sheet, a card sheet, the wallet, Moments, an
// app and the media viewer — each as the OS composites the window, title bar
// and all (macOS `screencapture -l <CGWindowID>`, Windows the screen under the
// window), and as a page screenshot. Then a recording of the window going from
// 1440 to 390 wide, by a real drag of its corner where the system lets a
// process post input, and on macOS the title bar and its buttons under real
// input. Everything lands in test-results/phone-width/ with summary.json /
// summary.md saying what was done how.
//
// What fails the test is the window, never the runner: a capture or input
// the system does not permit is written down as "not permitted". With input
// proven to work (the page saw a real mouse move) a drag on the title bar that
// moves nothing, a double-click on it that zooms nothing, or a minimise button
// that does not minimise, fail it. So do the page's own invariants in the real
// window: the preload's host is the one in use, the page draws the lights
// where it should and nowhere else, a title bar sits above it where there
// should be one (macOS below 1024, Windows), and it is in the appearance it
// was asked for.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { launch, type Launched } from "./fixtures";
import { captureWindow, doubleClickAction, geometry, inputAccess, mouse, OS, place, pngSize, record, windowButtons, type Geometry, type Outcome, type Rect } from "./os/real";

const WEB_DIR = process.env.MAFOLD_DESKTOP_SHOTS_PAGE ?? join(__dirname, "web");
const HAVE_PAGE = existsSync(join(WEB_DIR, "index.html")) && existsSync(join(WEB_DIR, "harness.js"));

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 720 },
  { width: 700, height: 820 },
  { width: 390, height: 844 },
] as const;
type Size = (typeof SIZES)[number];
/** The dark set: every size, as light. */
const DARK_SIZES: readonly Size[] = SIZES;
/** A title bar is at least this tall, in points (Windows ~31). */
const TITLE_BAR_MIN = 20;
/** The web's desktop breakpoint (useIsDesktop): at 100% zoom, a window this
 *  wide has the chat list's head for the page's lights, and no shell bar. */
const WIDE = 1024;

/** mafold-web test/windowLights/harness.tsx `Layout`, the part used here. */
interface Layout {
  signedIn: boolean;
  chat?: boolean;
  folders?: number;
  flags?: Record<string, boolean>;
  theme?: "light" | "dark";
}
type Lights = Record<string, (...a: unknown[]) => unknown>;

interface Screen {
  name: string;
  layout: Layout;
  /** Gets the screen there once the layout is up. */
  go?: (s: Session) => Promise<void>;
}
interface Session {
  l: Launched;
  page: Page;
}

/** One of the shell's menu commands, the way a person picks it (menu.ts):
 *  found by its accelerator, clicked. */
async function menuCommand(app: ElectronApplication, accelerator: string): Promise<void> {
  const ok = await app.evaluate(({ Menu }, acc) => {
    type Item = { accelerator?: string | null; submenu?: { items: Item[] } | null; click: (...a: unknown[]) => void };
    const find = (items: Item[]): Item | null => {
      for (const it of items) {
        if (it.accelerator === acc) return it;
        const sub = it.submenu ? find(it.submenu.items) : null;
        if (sub) return sub;
      }
      return null;
    };
    const menu = Menu.getApplicationMenu() as unknown as { items: Item[] } | null;
    const it = menu ? find(menu.items) : null;
    if (!it) return false;
    it.click();
    return true;
  }, accelerator);
  if (!ok) throw new Error(`no menu item with accelerator ${accelerator}`);
}

/** A harness driver (`window.__lights.<name>()`). */
const drive = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(([n, a]) => ((window as unknown as { __lights: Lights }).__lights[n as string] as (...x: unknown[]) => unknown)(...(a as unknown[])), [name, args] as const);

const text = (page: Page, s: string) => page.getByText(s, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const SIGNED_IN: Layout = { signedIn: true };
const SCREENS: Screen[] = [
  { name: "chats", layout: SIGNED_IN },
  { name: "chat", layout: { signedIn: true, chat: true } },
  {
    name: "settings",
    layout: SIGNED_IN,
    go: async ({ l, page }) => {
      await menuCommand(l.app, "CmdOrCtrl+,");
      await text(page, "My Profile");
    },
  },
  {
    name: "settings-appearance",
    layout: SIGNED_IN,
    // Straight to the page, the way a link to it opens Settings: on a phone a
    // Settings already open on its list stays there (it takes the page it is
    // asked for when it opens).
    go: async ({ page }) => {
      await drive(page, "settings", "appearance");
      await settle(1200);
    },
  },
  {
    name: "profile",
    layout: SIGNED_IN,
    go: async ({ page }) => {
      await drive(page, "settings", "profile");
      await settle(1200);
    },
  },
  { name: "new-chat", layout: SIGNED_IN, go: async ({ l }) => menuCommand(l.app, "CmdOrCtrl+N") },
  {
    name: "confirm",
    layout: SIGNED_IN,
    go: async ({ page }) => {
      await drive(page, "confirm");
      await text(page, "A sheet over the window's chrome.");
    },
  },
  { name: "card-modal", layout: SIGNED_IN, go: async ({ page }) => void (await drive(page, "cardModal")) },
  { name: "wallet", layout: SIGNED_IN, go: async ({ page }) => void (await drive(page, "wallet")) },
  { name: "moments", layout: SIGNED_IN, go: async ({ page }) => void (await drive(page, "moments")) },
  { name: "app", layout: SIGNED_IN, go: async ({ page }) => void (await drive(page, "appFull")) },
  { name: "media", layout: { signedIn: true, chat: true }, go: async ({ page }) => void (await drive(page, "media")) },
];
/** The same screens with Settings ▸ Appearance ▸ Dark picked. */
const DARK_SCREENS: Screen[] = SCREENS.map((sc) => ({ ...sc, name: `dark-${sc.name}`, layout: { ...sc.layout, theme: "dark" } }));

// ── what happened, for summary.json / summary.md ──
interface ShotRecord {
  size: string;
  screen: string;
  window: string;
  page: string;
  problem?: string;
}
type Check = { name: string; result: "ok" | "failed" | "not permitted" | "not applicable"; detail: string };
const summary = {
  os: OS,
  runner: { image: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null, arch: process.arch },
  display: null as null | { area: Geometry["area"]; scale: number },
  host: null as null | { version: string; os: string; caps: string[] },
  doubleClickAction: "",
  inputAccess: "",
  /** The title bar's height at each size: the window's top to its page's. */
  titleBar: {} as Record<string, number>,
  shots: [] as ShotRecord[],
  recording: null as null | Record<string, unknown>,
  input: [] as (Check & { width: number })[],
  notes: [] as string[],
};

let server: Server;
let web = "";
let api = "";
let s: Session | null = null;
let OUT = "";

const layoutPath = (layout: Layout) => `/app?layout=${encodeURIComponent(JSON.stringify(layout))}`;

async function open(layout: Layout): Promise<Page> {
  const page = s!.page;
  await page.goto(web + layoutPath(layout));
  await page.waitForFunction(() => !!(window as unknown as { __lights?: unknown }).__lights, null, { timeout: 30_000 });
  if (layout.signedIn) await text(page, "Peer");
  await settle(400);
  return page;
}

/** What the page shows of the window's chrome, and the appearance it is in. */
const pageState = (page: Page) =>
  page.evaluate(() => ({
    // mafold-web WindowLights.tsx: drawn only for a shell offering `window-controls`.
    drawsLights: !!document.querySelector(".mf-wl-row, .mf-window-lights"),
    theme: document.body.dataset.theme ?? "auto",
  }));

// Not `serial`: one width that fails must not skip the others' pictures. A
// failure restarts the worker (and with it the shell, in beforeAll); the
// summary picks up where the last one left off (beforeAll reads it back).
test.skip(!HAVE_PAGE, `no shots page at ${WEB_DIR} (the monorepo's desktop-tests.yml builds it: scripts/ci/public-desktop/shots-page.mjs)`);

test.beforeAll(async () => {
  const js = readFileSync(join(WEB_DIR, "harness.js"));
  const html = readFileSync(join(WEB_DIR, "index.html"));
  server = createServer((req, res) => {
    if (req.url?.startsWith("/harness.js")) res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" }).end(js);
    else if (req.url?.startsWith("/app")) res.writeHead(200, { "content-type": "text/html" }).end(html);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  web = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The api origin: nothing the offline page asks for (its core never comes up).
  api = "http://127.0.0.1:9";
  const l = await launch(web, api, { MAFOLD_DESKTOP_START_PATH: layoutPath(SIGNED_IN) });
  s = { l, page: l.page };
  OUT = join(test.info().project.outputDir, "phone-width");
  mkdirSync(OUT, { recursive: true });
  // A worker before this one (restarted after a failure) wrote down its part.
  try {
    const before = JSON.parse(readFileSync(join(OUT, "summary.json"), "utf8")) as typeof summary;
    summary.host = before.host;
    summary.inputAccess = before.inputAccess;
    summary.recording = before.recording;
    Object.assign(summary.titleBar, before.titleBar);
    summary.shots.push(...before.shots);
    summary.input.push(...before.input);
    summary.notes.push(...before.notes);
  } catch {
    /* the first */
  }
  const g = await geometry(l.app);
  summary.display = { area: g.area, scale: g.scale };
  summary.doubleClickAction = await doubleClickAction();
});

test.afterAll(async () => {
  await s?.l.app.close();
  await new Promise((r) => server?.close(r));
  if (!OUT) return;
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  const md = [
    `# Phone-width shots — ${OS}`,
    "",
    `Runner ${summary.runner.image ?? "?"} ${summary.runner.version ?? ""} (${summary.runner.arch}); work area ${JSON.stringify(summary.display?.area)} @${summary.display?.scale}x; host ${summary.host?.os} caps ${summary.host?.caps.join(",")}.`,
    `Title bar: ${Object.entries(summary.titleBar).map(([k, v]) => `${k} ${v}pt`).join(", ") || "—"}. Title-bar double-click: ${summary.doubleClickAction}. Input access: ${summary.inputAccess || "n/a"}.`,
    ...summary.notes.map((n) => `- ${n}`),
    "",
    "## Shots",
    "| size | screen | window (OS) | page | problem |",
    "|---|---|---|---|---|",
    ...summary.shots.map((r) => `| ${r.size} | ${r.screen} | ${r.window} | ${r.page} | ${r.problem ?? ""} |`),
    "",
    "## Recording",
    "```json",
    JSON.stringify(summary.recording, null, 2),
    "```",
    "",
    "## Real input",
    "| width | check | result | detail |",
    "|---|---|---|---|",
    ...summary.input.map((c) => `| ${c.width} | ${c.name} | ${c.result} | ${c.detail.replace(/\|/g, "/")} |`),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "summary.md"), md);
});

const isOutcome = (v: object): v is Outcome => typeof (v as { ok?: unknown }).ok === "boolean";
const outcomeText = (o: Outcome) => (o.ok ? `ok${o.note ? ` (${o.note})` : ""}` : `${o.notPermitted ? "not permitted" : "n/a"}: ${o.reason}`);
const prefix = OS === "macos" ? "mac" : OS === "windows" ? "win" : "linux";

test("the page in the window is the shots page, on the shell's own host, which offers the bar on macOS", async () => {
  const page = await open(SIGNED_IN);
  const host = await page.evaluate(() => {
    const h = (window as unknown as { mafoldHost?: { version: string; os: string; caps: string[] } }).mafoldHost;
    return h ? { version: h.version, os: h.os, caps: [...h.caps] } : null;
  });
  summary.host = host;
  // The harness keeps a host that is already there (harness.tsx); its stand-in says 0.0.0-harness.
  expect(host, "the preload's window.mafoldHost").not.toBeNull();
  expect(host!.version).not.toBe("0.0.0-harness");
  for (const cap of ["window-controls", "window-arrange", "window-titlebar"]) expect(host!.caps.includes(cap), cap).toBe(OS === "macos");
  // English, not keys.
  await text(page, "Peer");
  await menuCommand(s!.l.app, "CmdOrCtrl+,");
  await text(page, "My Profile");
});

/** The window at `size`, each of `screens` in it: the OS's picture and the
 *  page's. Resolves to what went wrong. */
async function shoot(size: Size, screens: Screen[]): Promise<string[]> {
  const { l } = s!;
  const problems: string[] = [];
  await place(l.app, size.width, size.height);
  // The page hears its new width and tells the shell its layout (macOS): the
  // frame follows that, not the resize itself.
  await settle(800);
  const g = await geometry(l.app);
  const tag = `${size.width}x${size.height}`;
  // A window wider than the screen is the runner's screen, not the shell (a
  // Windows runner may come up at 1024×768): noted, not failed. Narrower than
  // asked on a screen that fits it is the shell's minimum getting in the way.
  const fits = size.width <= g.area.width && size.height <= g.area.height;
  if (g.bounds.width !== size.width || g.bounds.height !== size.height) {
    const note = `window is ${g.bounds.width}×${g.bounds.height}, asked for ${tag} (work area ${g.area.width}×${g.area.height})`;
    if (fits) problems.push(note);
    else summary.notes.push(note);
  }
  // The title bar: the page starts below the window's top. macOS: the shell's
  // own, below the breakpoint only; Windows: the system's, always (Linux under
  // xvfb has no window manager to draw one).
  const wide = g.bounds.width >= WIDE;
  const bar = g.page.y - g.bounds.y;
  summary.titleBar[tag] = bar;
  if (OS === "macos" && wide && bar !== 0) problems.push(`a bar above the page at ${g.bounds.width} wide: it starts ${bar}pt below the window's top`);
  if (OS === "macos" && !wide && bar !== 32) problems.push(`the page starts ${bar}pt below the window's top at ${g.bounds.width} wide, not under a 32pt bar`);
  if (OS === "windows" && bar < TITLE_BAR_MIN) problems.push(`no title bar above the page: it starts ${bar}pt below the window's top`);
  // The page draws the lights on macOS in the wide layout only.
  const lights = OS === "macos" && wide;
  for (const screen of screens) {
    const base = `${prefix}-${size.width}-${screen.name}`;
    const rec: ShotRecord = { size: tag, screen: screen.name, window: "", page: "" };
    const wrong: string[] = [];
    try {
      const page = await open(screen.layout);
      await screen.go?.(s!);
      await settle();
      const st = await pageState(page);
      if (st.drawsLights !== lights) wrong.push(lights ? "the page draws no window lights" : "the page draws window lights");
      const now = await geometry(l.app);
      if (now.page.y !== g.page.y) wrong.push(`the page moved to ${now.page.y - now.bounds.y}pt below the window's top`);
      if (st.theme !== (screen.layout.theme ?? "auto")) wrong.push(`the page is in ${st.theme}, asked for ${screen.layout.theme ?? "auto"}`);
    } catch (e) {
      wrong.push(`could not reach the screen: ${(e as Error).message.split("\n")[0]}`);
    }
    if (wrong.length) rec.problem = wrong.join("; ");
    // Pictures whatever happened: a broken screen is worth seeing too.
    const winFile = join(OUT, `${base}.png`);
    const o = await captureWindow(l.app, winFile);
    const dim = o.ok ? pngSize(winFile) : null;
    rec.window = o.ok ? `${base}.png${dim ? ` ${dim.width}×${dim.height}` : ""}` : outcomeText(o);
    const pageFile = join(OUT, `${base}.page.png`);
    try {
      await s!.page.screenshot({ path: pageFile });
      rec.page = `${base}.page.png`;
    } catch (e) {
      rec.page = `failed: ${(e as Error).message.split("\n")[0]}`;
    }
    summary.shots.push(rec);
    if (rec.problem) problems.push(`${screen.name}: ${rec.problem}`);
  }
  return problems;
}

for (const size of SIZES) {
  test(`shots at ${size.width}×${size.height}, light`, async () => {
    test.setTimeout(300_000);
    expect(await shoot(size, SCREENS), `at ${size.width}x${size.height}`).toEqual([]);
  });
}
for (const size of DARK_SIZES) {
  test(`shots at ${size.width}×${size.height}, dark`, async () => {
    test.setTimeout(300_000);
    expect(await shoot(size, DARK_SCREENS), `at ${size.width}x${size.height}, dark`).toEqual([]);
  });
}

/** Whether a real mouse reaches the page: move it to the middle of the page
 *  (or to `at`, in the page) and see whether the page saw it there (the
 *  positive control for every input check below). */
async function inputReaches(page: Page, g: Geometry, at?: [number, number]): Promise<Outcome> {
  await page.evaluate(() => {
    const w = window as unknown as { __mm: number[] | null };
    w.__mm = null;
    addEventListener("mousemove", (e) => (w.__mm = [e.clientX, e.clientY]), { capture: true });
  });
  const [x, y] = at ?? [Math.round(g.page.width / 2), Math.round(g.page.height / 2)];
  for (const dx of [0, 7]) {
    const o = await mouse(["move", g.page.x + x + dx, g.page.y + y], g.scale);
    if (!o.ok) return o;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const mm = await page.evaluate(() => (window as unknown as { __mm: number[] | null }).__mm);
    if (mm && Math.abs(mm[0] - x) < 30 && Math.abs(mm[1] - y) < 30) return { ok: true };
    await settle(100);
  }
  return { ok: false, notPermitted: true, reason: "the page saw no mouse move (the system dropped the posted events)" };
}

test("real input on the window's chrome: the shell's bar at 390, the page's strip and lights at 1440 (macOS)", async () => {
  test.skip(OS !== "macos", "the title bar's buttons are read through macOS Accessibility");
  test.setTimeout(480_000);
  const { l } = s!;
  const pid = l.app.process().pid!;
  summary.inputAccess = await inputAccess();
  const failures: string[] = [];
  for (const width of [390, 1440]) {
    const add = (name: string, result: Check["result"], detail: string) => {
      summary.input.push({ width, name, result, detail });
      if (result === "failed") failures.push(`${width}: ${name} — ${detail}`);
    };
    const wide = width >= WIDE;
    // What drags the window, and what holds the lights: the shell's bar below
    // the breakpoint (the system's lights in it), the page's own above it.
    const bar = wide ? "the page's top strip" : "the title bar";
    const lightsAre = wide ? "the page's lights" : "the system's lights in the bar";
    let g = await place(l.app, width, 760, 120);
    const page = await open(SIGNED_IN);
    await settle(600);
    g = await geometry(l.app);
    const control = await inputReaches(page, g);
    if (!control.ok) {
      for (const n of [`hover ${lightsAre}`, `drag ${bar}`, `double-click ${bar}`, "minimise light"]) add(n, "not permitted", control.reason);
      continue;
    }
    add("mouse reaches the page", "ok", "a real move landed where it was sent");
    if (wide) {
      // Just after the phone layout (390 runs first): the page's own head is the
      // page's again, the me pill at its top under where the bar was — no bar
      // left behind to drag from.
      const head = await inputReaches(page, g, [150, 24]);
      add("the page's head takes the mouse (no bar left over it)", head.ok ? "ok" : "failed", head.ok ? "a move at (150,24) reached the page" : head.reason);
    }
    // A point that drags: the middle of the shell's bar, clear of the lights;
    // or the page's strip above its pill row (10pt tall), well right of them.
    const dragAt = (geo: Geometry): [number, number] =>
      wide ? [geo.page.x + 300, geo.page.y + 4] : [geo.bounds.x + Math.round(geo.bounds.width / 2), geo.bounds.y + Math.round((geo.page.y - geo.bounds.y) / 2)];
    // The lights, on screen: the system's through Accessibility, or the page's own buttons.
    const lightsNow = async (geo: Geometry): Promise<{ close: Rect; minimize: Rect } | string> => {
      if (!wide) {
        const b = await windowButtons(pid);
        if (isOutcome(b)) return outcomeText(b);
        return b.close && b.minimize ? { close: b.close, minimize: b.minimize } : "no buttons found";
      }
      const boxes = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".mf-wl-row button")).slice(0, 2).map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      if (boxes.length < 2) return "the page's lights are not there";
      const on = (r: Rect): Rect => ({ x: Math.round(geo.page.x + r.x), y: Math.round(geo.page.y + r.y), width: Math.round(r.width), height: Math.round(r.height) });
      return { close: on(boxes[0]), minimize: on(boxes[1]) };
    };

    // Hover: the glyphs show (the system's or the page's); the picture is the evidence.
    {
      const lights = await lightsNow(g);
      if (typeof lights === "string") add(`hover ${lightsAre}`, wide ? "failed" : "not permitted", lights);
      else {
        const b = lights.close;
        await mouse(["move", Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]);
        await settle(600);
        const o = await captureWindow(l.app, join(OUT, `mac-${width}-hover.png`));
        add(`hover ${lightsAre}`, o.ok ? "ok" : "not permitted", o.ok ? `lights at ${JSON.stringify(lights)}; picture mac-${width}-hover.png` : outcomeText(o));
        await mouse(["move", g.page.x + Math.round(g.page.width / 2), g.page.y + Math.round(g.page.height / 2)]);
      }
    }

    // Drag: it moves the window.
    {
      const before = (await geometry(l.app)).bounds;
      const [x, y] = dragAt(g);
      const dx = 80;
      const dy = 50;
      const o = await mouse(["drag", x, y, x + dx, y + dy, 700, 24]);
      if (!o.ok) add(`drag ${bar}`, "not permitted", outcomeText(o));
      else {
        await settle(500);
        const after = (await geometry(l.app)).bounds;
        const mx = after.x - before.x;
        const my = after.y - before.y;
        add(`drag ${bar}`, Math.abs(mx - dx) <= 12 && Math.abs(my - dy) <= 12 ? "ok" : "failed", `at (${x - before.x},${y - before.y}) in the window: asked (${dx},${dy}), moved (${mx},${my})`);
      }
      g = await place(l.app, width, 760, 120);
    }

    // Double-click: what the system is set to do with a title bar.
    const action = summary.doubleClickAction;
    if (/none/i.test(action)) add(`double-click ${bar}`, "not applicable", `AppleActionOnDoubleClick = ${action}`);
    else {
      const before = await geometry(l.app);
      const o = await mouse(["dclick", ...dragAt(before)]);
      if (!o.ok) add(`double-click ${bar}`, "not permitted", outcomeText(o));
      else {
        await settle(1500);
        const after = await geometry(l.app);
        const minimise = /minimi[sz]e/i.test(action);
        const changed = minimise
          ? after.minimized
          : after.maximized !== before.maximized || Math.abs(after.bounds.width - before.bounds.width) > 4 || Math.abs(after.bounds.height - before.bounds.height) > 4;
        add(
          `double-click ${bar}`,
          changed ? "ok" : "failed",
          `${action}: ${before.bounds.width}×${before.bounds.height}${before.maximized ? " max" : ""} → ${after.bounds.width}×${after.bounds.height}${after.maximized ? " max" : ""}${after.minimized ? " min" : ""}`,
        );
      }
      g = await place(l.app, width, 760, 120);
      await settle(600);
      g = await geometry(l.app);
    }

    // The minimise light, where it is now.
    const now = await lightsNow(g);
    if (typeof now === "string") add("minimise light", wide ? "failed" : "not permitted", now);
    else {
      const m = now.minimize;
      const o = await mouse(["click", Math.round(m.x + m.width / 2), Math.round(m.y + m.height / 2)]);
      if (!o.ok) add("minimise light", "not permitted", outcomeText(o));
      else {
        await settle(1200);
        const after = await geometry(l.app);
        add("minimise light", after.minimized ? "ok" : "failed", after.minimized ? `minimised (${lightsAre})` : "window still on screen");
      }
      await place(l.app, width, 760, 120);
    }
  }
  expect(failures).toEqual([]);
});

test("recording: the window from wide to 390", async () => {
  test.setTimeout(300_000);
  const { l } = s!;
  // From as wide as the screen holds (a CI Mac's is 1024): a corner off the
  // screen can't be dragged.
  const area = (await geometry(l.app)).area;
  const from = Math.min(1440, area.width - 48);
  let g = await place(l.app, from, Math.min(900, area.height - 48));
  const page = await open({ signedIn: true, chat: true });
  g = await geometry(l.app);
  const info: Record<string, unknown> = { from: `${g.bounds.width}×${g.bounds.height}` };
  summary.recording = info;

  const input = OS === "linux" ? ({ ok: false, notPermitted: true, reason: "no real input on Linux" } as Outcome) : await inputReaches(page, g);
  info.input = outcomeText(input);
  const secs = 12;
  const rec = await record(join(OUT, `${prefix}-resize`), secs);
  info.recorder = rec?.tool ?? "none on this runner";
  await settle(1500);

  const t0 = Date.now();
  let how = "";
  if (input.ok) {
    // The window's bottom-right corner, dragged left to past the minimum.
    const b = g.bounds;
    const inset = OS === "windows" ? 4 : 3;
    const from: [number, number] = [b.x + b.width - inset, b.y + b.height - inset];
    const o = await mouse(["drag", from[0], from[1], b.x + 300, from[1], 5000, 80], g.scale);
    const after = await geometry(l.app);
    // Counted only if it got all the way down: a drag the OS followed part of
    // the way still leaves the steps below to finish the story.
    how = o.ok && after.bounds.width <= 400 ? `real drag of the bottom-right corner → ${after.bounds.width}×${after.bounds.height}` : "";
    if (!how) info.drag = `the corner drag did not get to phone width (${outcomeText(o)}; width ${after.bounds.width})`;
  }
  if (!how) {
    // No real input (or a drag that stopped short): step the window's size
    // from the main process instead.
    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      const w = Math.round(from - ((from - 390) * i) / steps);
      await l.app.evaluate(({ BaseWindow }, w) => {
        const win = BaseWindow.getAllWindows()[0];
        const b = win.getBounds();
        win.setBounds({ ...b, width: w });
      }, w);
      await settle(110);
    }
    how = info.drag ? "setBounds in 30 steps (the real drag did not get there)" : "setBounds in 30 steps (no real input on this runner)";
  }
  info.how = how;
  info.resizeMs = Date.now() - t0;
  info.to = `${(await geometry(l.app)).bounds.width}`;

  if (rec) info.result = outcomeText(await rec.done);
  else {
    // No recorder: a picture of where it ended up instead.
    const o = await captureWindow(l.app, join(OUT, `${OS}-resize-end.png`));
    info.result = `no recording; end frame ${outcomeText(o)}`;
  }
  // The window got to phone width one way or the other.
  expect(Number(info.to)).toBeLessThanOrEqual(400);
});
