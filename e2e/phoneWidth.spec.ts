// The window at phone width, photographed by the OS (10-31: the window goes
// down to 390×480 on every OS, and on macOS the page's lights stay on top of
// every screen and layer). The real shell, the real web screens: the page is
// mafold-web's window-lights harness with the English pack
// (mafold-web/test/windowLights/shots.tsx), which the monorepo's dispatch job
// builds and push-tree.sh copies in as e2e/web/ — this tree alone has no web
// app, so without that copy the whole file is skipped.
//
// For a person to look at, mostly: at 1440×900, 1024×720, 700×820 and 390×844
// it takes the chat list, a chat, Settings (the list, a section, My Profile),
// New Chat, a confirm sheet, a card sheet, the wallet, Moments, an app and the
// media viewer — each as the OS composites the window (macOS
// `screencapture -l <CGWindowID>`, Windows the screen under the window; the
// lights are in those, not in a page screenshot) and as a page screenshot. Then
// a recording of the window going from 1440 to 390 wide, by a real drag of its
// corner where the system lets a process post input, and on macOS the title
// bar and the lights under real input. Everything lands in
// test-results/phone-width/ with summary.json / summary.md saying what was
// done how.
//
// What fails the test is the window, never the runner: a capture or input
// the system does not permit is written down as "not permitted". With input
// proven to work (the page saw a real mouse move) a double-click on the title
// bar that zooms nothing, a drag that moves nothing, lights that show no
// glyphs on hover, or a minimise light that does not minimise, fail it. So do
// the page's own invariants in the real window: the preload's host is the
// one in use, and on macOS the lights are drawn and are the last thing in
// <body> on every screen.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { launch, type Launched } from "./fixtures";
import { captureWindow, doubleClickAction, geometry, inputAccess, mouse, OS, place, pngSize, record, type Geometry, type Outcome } from "./os/real";

const WEB_DIR = process.env.MAFOLD_DESKTOP_SHOTS_PAGE ?? join(__dirname, "web");
const HAVE_PAGE = existsSync(join(WEB_DIR, "index.html")) && existsSync(join(WEB_DIR, "harness.js"));

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 720 },
  { width: 700, height: 820 },
  { width: 390, height: 844 },
] as const;

/** mafold-web test/windowLights/harness.tsx `Layout`, the part used here. */
interface Layout {
  signedIn: boolean;
  chat?: boolean;
  folders?: number;
  flags?: Record<string, boolean>;
}
type Lights = Record<string, (...a: unknown[]) => unknown>;

interface Screen {
  name: string;
  layout: Layout;
  /** Gets the screen there once the layout is up; resolves to a note, if any. */
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
    // Straight to the page, the way a link to it opens Settings: on a phone a
    // Settings already open on its list stays there (it takes the page it is
    // asked for when it opens).
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

// ── what happened, for summary.json / summary.md ──
interface ShotRecord {
  size: string;
  screen: string;
  window: string;
  page: string;
  lights?: { drawn: boolean; last: boolean; underPill: number };
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
  // macOS: a new document has the system's lights back until the page draws its own (window.ts).
  if (OS === "macos") await page.waitForSelector(".mf-wl-row", { timeout: 15_000 });
  await settle(400);
  return page;
}

/** The lights on macOS: drawn, and the last thing in <body> (WindowLights.tsx). */
const lightsState = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector(".mf-wl-row");
    const last = !!row && !!document.body.lastElementChild?.contains(row);
    const l = (window as unknown as { __lights: { underPill?: () => unknown[] } }).__lights;
    return { drawn: !!row, last, underPill: l.underPill ? l.underPill().length : -1 };
  });

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
    `Title-bar double-click: ${summary.doubleClickAction}. Input access: ${summary.inputAccess || "n/a"}.`,
    ...summary.notes.map((n) => `- ${n}`),
    "",
    "## Shots",
    "| size | screen | window (OS) | page | lights | problem |",
    "|---|---|---|---|---|---|",
    ...summary.shots.map((r) => `| ${r.size} | ${r.screen} | ${r.window} | ${r.page} | ${r.lights ? `drawn ${r.lights.drawn}, last ${r.lights.last}, under pill ${r.lights.underPill}` : "—"} | ${r.problem ?? ""} |`),
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

const outcomeText = (o: Outcome) => (o.ok ? `ok${o.note ? ` (${o.note})` : ""}` : `${o.notPermitted ? "not permitted" : "n/a"}: ${o.reason}`);

test("the page in the window is the shots page, on the shell's own host", async () => {
  const page = await open(SIGNED_IN);
  const host = await page.evaluate(() => {
    const h = (window as unknown as { mafoldHost?: { version: string; os: string; caps: string[] } }).mafoldHost;
    return h ? { version: h.version, os: h.os, caps: [...h.caps] } : null;
  });
  summary.host = host;
  // The harness keeps a host that is already there (harness.tsx); its stand-in says 0.0.0-harness.
  expect(host, "the preload's window.mafoldHost").not.toBeNull();
  expect(host!.version).not.toBe("0.0.0-harness");
  expect(host!.caps.includes("window-controls")).toBe(OS === "macos");
  // English, not keys.
  await text(page, "Peer");
  await menuCommand(s!.l.app, "CmdOrCtrl+,");
  await text(page, "My Profile");
});

for (const size of SIZES) {
  test(`shots at ${size.width}×${size.height}`, async () => {
    test.setTimeout(300_000);
    const { l } = s!;
    const problems: string[] = [];
    const g = await place(l.app, size.width, size.height);
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
    for (const screen of SCREENS) {
      const base = `${OS === "macos" ? "mac" : OS === "windows" ? "win" : "linux"}-${size.width}-${screen.name}`;
      const rec: ShotRecord = { size: tag, screen: screen.name, window: "", page: "" };
      try {
        const page = await open(screen.layout);
        await screen.go?.(s!);
        await settle();
        if (OS === "macos") {
          rec.lights = await lightsState(page);
          if (!rec.lights.drawn) rec.problem = "lights not drawn";
          else if (!rec.lights.last) rec.problem = "lights box is not last in <body>";
        }
      } catch (e) {
        rec.problem = `could not reach the screen: ${(e as Error).message.split("\n")[0]}`;
      }
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
    expect(problems, `at ${tag}`).toEqual([]);
  });
}

/** Whether a real mouse reaches the page: move it to the middle of the window
 *  and see whether the page saw it there (the positive control for every
 *  input check below). */
async function inputReaches(page: Page, g: Geometry): Promise<Outcome> {
  await page.evaluate(() => {
    const w = window as unknown as { __mm: number[] | null };
    w.__mm = null;
    addEventListener("mousemove", (e) => (w.__mm = [e.clientX, e.clientY]), { capture: true });
  });
  const x = Math.round(g.content.width / 2);
  const y = Math.round(g.content.height / 2);
  for (const dx of [0, 7]) {
    const o = await mouse(["move", g.content.x + x + dx, g.content.y + y], g.scale);
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

test("real input on the title bar and the lights (macOS)", async () => {
  test.skip(OS !== "macos", "the page draws the lights on macOS only");
  test.setTimeout(480_000);
  const { l } = s!;
  summary.inputAccess = await inputAccess();
  const failures: string[] = [];
  for (const width of [390, 1440]) {
    const add = (name: string, result: Check["result"], detail: string) => {
      summary.input.push({ width, name, result, detail });
      if (result === "failed") failures.push(`${width}: ${name} — ${detail}`);
    };
    let g = await place(l.app, width, 760, 120);
    const page = await open(SIGNED_IN);
    g = await geometry(l.app);
    const control = await inputReaches(page, g);
    if (!control.ok) {
      for (const n of ["hover shows glyphs", "drag the strip", "drag the pill", "double-click the strip", "minimise light"]) add(n, "not permitted", control.reason);
      continue;
    }
    add("mouse reaches the page", "ok", "a real move landed where it was sent");

    const rects = await page.evaluate(() => {
      const r = (el: Element | null) => (el ? (({ left, top, width, height }) => ({ left, top, width, height }))(el.getBoundingClientRect()) : null);
      return { pill: r(document.querySelector(".mf-window-lights")), row: r(document.querySelector(".mf-wl-row")), buttons: Array.from(document.querySelectorAll(".mf-wl-row button"), r) };
    });
    const at = (cx: number, cy: number): [number, number] => [g.content.x + Math.round(cx), g.content.y + Math.round(cy)];

    // Hover: the glyphs come up on all three while the pointer is on the row.
    const close = rects.buttons[0];
    if (close) {
      await mouse(["move", ...at(close.left + close.width / 2, close.top + close.height / 2)]);
      await settle(500);
      const glyphs = await page.evaluate(() => document.querySelectorAll(".mf-wl-row svg").length);
      add("hover shows glyphs", glyphs > 0 ? "ok" : "failed", `${glyphs} glyph(s) with the pointer on the close light`);
      await mouse(["move", ...at(g.content.width / 2, g.content.height / 2)]);
    } else add("hover shows glyphs", "failed", "no lights in the page");

    // Drags: the strip above the pill row, then the pill above the lights.
    const dragBy = async (name: string, from: [number, number], dx: number, dy: number) => {
      const before = (await geometry(l.app)).bounds;
      const o = await mouse(["drag", from[0], from[1], from[0] + dx, from[1] + dy, 700, 24]);
      if (!o.ok) return add(name, "not permitted", outcomeText(o));
      await settle(500);
      const after = (await geometry(l.app)).bounds;
      const mx = after.x - before.x;
      const my = after.y - before.y;
      add(name, Math.abs(mx - dx) <= 12 && Math.abs(my - dy) <= 12 ? "ok" : "failed", `asked (${dx},${dy}), moved (${mx},${my})`);
      await place(l.app, width, 760, 120);
      g = await geometry(l.app);
    };
    await dragBy("drag the strip", at(g.content.width / 2, 4), 80, 50);
    if (rects.pill && rects.row) await dragBy("drag the pill", at(rects.pill.left + rects.pill.width / 2, (rects.pill.top + rects.row.top) / 2), 60, 40);
    else add("drag the pill", "failed", "no pill in the page");

    // Double-click on the strip: what the system is set to do with a title bar.
    const action = summary.doubleClickAction;
    if (/none/i.test(action)) add("double-click the strip", "not applicable", `AppleActionOnDoubleClick = ${action}`);
    else {
      const before = await geometry(l.app);
      const o = await mouse(["dclick", ...at(before.content.width / 2, 4)]);
      if (!o.ok) add("double-click the strip", "not permitted", outcomeText(o));
      else {
        await settle(1500);
        const after = await geometry(l.app);
        const minimise = /minimi[sz]e/i.test(action);
        const changed = minimise
          ? after.minimized
          : after.maximized !== before.maximized || Math.abs(after.bounds.width - before.bounds.width) > 4 || Math.abs(after.bounds.height - before.bounds.height) > 4;
        add(
          "double-click the strip",
          changed ? "ok" : "failed",
          `${action}: ${before.bounds.width}×${before.bounds.height}${before.maximized ? " max" : ""} → ${after.bounds.width}×${after.bounds.height}${after.maximized ? " max" : ""}${after.minimized ? " min" : ""}`,
        );
      }
      await place(l.app, width, 760, 120);
      g = await geometry(l.app);
    }

    // The minimise light.
    const min = rects.buttons[1];
    if (min) {
      const o = await mouse(["click", ...at(min.left + min.width / 2, min.top + min.height / 2)]);
      if (!o.ok) add("minimise light", "not permitted", outcomeText(o));
      else {
        await settle(1200);
        const after = await geometry(l.app);
        add("minimise light", after.minimized ? "ok" : "failed", after.minimized ? "minimised" : "window still on screen");
      }
      await place(l.app, width, 760, 120);
    } else add("minimise light", "failed", "no lights in the page");
  }
  expect(failures).toEqual([]);
});

test("recording: the window from 1440 to 390 wide", async () => {
  test.setTimeout(300_000);
  const { l } = s!;
  let g = await place(l.app, 1440, 900);
  const page = await open({ signedIn: true, chat: true });
  g = await geometry(l.app);
  const info: Record<string, unknown> = { from: `${g.bounds.width}×${g.bounds.height}` };
  summary.recording = info;

  const input = OS === "linux" ? ({ ok: false, notPermitted: true, reason: "no real input on Linux" } as Outcome) : await inputReaches(page, g);
  info.input = outcomeText(input);
  const secs = 12;
  const rec = await record(join(OUT, `${OS === "macos" ? "mac" : OS === "windows" ? "win" : "linux"}-resize`), secs);
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
      const w = Math.round(1440 - ((1440 - 390) * i) / steps);
      await l.app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0];
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
