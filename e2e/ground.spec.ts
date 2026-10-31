// The window stands on the app's own ground (client-shared/appGround.ts — the
// web's `--jBg`), in the light / dark the app is set to: it is what shows
// before the page paints, while it loads, around a resize, and on the offline
// page. It used to be a shade of its own (#f6f6f8 / #111113), so the window
// changed colour as the page arrived; and it followed the system on every
// launch, so someone who picked dark in a light system (or the other way
// round) opened on the wrong one first.
//
// The window's background reads as #rrggbb (letter case is Electron's), the
// page's as rgb().

import { expect, test } from "@playwright/test";

import { APP_GROUND } from "../src/shared/appGround.generated";
import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

type Scheme = "light" | "dark";

const windowGround = (l: Launched) =>
  l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getBackgroundColor().toLowerCase());
/** The appearance the shell is in: the system's until the app picks one. */
const scheme = (l: Launched) => l.app.evaluate(({ nativeTheme }): Scheme => (nativeTheme.shouldUseDarkColors ? "dark" : "light"));
const ground = (s: Scheme) => APP_GROUND[s].toLowerCase();
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const setAppearance = (l: Launched, mode: "light" | "dark" | "system") =>
  l.page.evaluate((m) => (window as unknown as { mafoldHost: { setAppearance(m: string): void } }).mafoldHost.setAppearance(m), mode);

let origins: Origins;
let l: Launched | null = null;

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

test("a new window opens on the app's ground for the system's appearance", async () => {
  l = await launch(origins.web, origins.api);
  // Nothing picked yet on a fresh profile: the system decides.
  expect(await l.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
  expect(await windowGround(l)).toBe(ground(await scheme(l)));
  await l.page.waitForSelector("#h");
});

test("the appearance picked in the app repaints the ground at once, and the next launch opens in it", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  const system = await scheme(l);
  // The other one, so the ground can only match through the choice.
  const picked: Scheme = system === "dark" ? "light" : "dark";

  await setAppearance(l, picked);
  await expect.poll(() => windowGround(l!)).toBe(ground(picked));

  // Relaunch on the same profile. The fixture page never sets an appearance,
  // so what the window opens in can only have been kept from last time.
  const userData = l.dirs.userData;
  await l.app.close();
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: userData });
  expect(await windowGround(l)).toBe(ground(picked));
  await l.page.waitForSelector("#h");
  // …and the page's first frame already sees it as the system's appearance —
  // what the web's "follow the system" setting and its first paint read.
  expect(await l.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(picked === "dark");

  // Back to following the system is a choice that is kept too.
  await setAppearance(l, "system");
  await expect.poll(() => windowGround(l!)).toBe(ground(system));
  await l.app.close();
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: userData });
  expect(await l.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
  expect(await windowGround(l)).toBe(ground(system));
});

test("the offline page stands on the same ground, light and dark", async () => {
  l = await launch("http://127.0.0.1:9", origins.api);
  await l.page.waitForURL(/offline\.html/);
  await l.page.waitForSelector("#title");
  const body = () => l!.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // The offline page has no bridge; the appearance the page would have set
  // reaches it the way it reaches the window — through the shell's theme.
  for (const s of ["light", "dark"] as const) {
    await l.app.evaluate(({ nativeTheme }, mode) => {
      nativeTheme.themeSource = mode;
    }, s);
    await expect.poll(body).toBe(rgb(APP_GROUND[s]));
    await expect.poll(() => windowGround(l!)).toBe(ground(s));
    await l.page.screenshot({ path: test.info().outputPath(`offline-${s}.png`) });
  }
});
