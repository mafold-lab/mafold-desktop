// A restart into a new version (the pill's「重启」, the tray's or the menu's
// "Restart to Update") comes back where the person was, and the page hears
// which version the shell came from (relaunch.ts). Until now every new process
// opened the start page — the chat list — whatever was open before.
//
// What the shell leaves for the next launch lives in its data directory, so
// these tests write it there before starting one (fixtures.ts `profile`), or
// let one shell write it and start the next on the same directory. Unpackaged
// there is no feed: a restart is written to externalLog instead of quitting
// (update.spec.ts), and nothing is installed — the next launch is the test's.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { launch, profile, startOrigins, type Launched, type Origins } from "./fixtures";

const CONV = "0f8fad5b-d9cb-469f-a165-70867728950e";
const RELAUNCH = "relaunch.json"; // relaunch.ts RELAUNCH_FILE
const LAST_VERSION = "last-version"; // relaunch.ts LAST_VERSION_FILE
const MIN = 60_000;

type HostUpdate = { current: string; phase: string; next?: string; updatedFrom?: string };
type Host = { version: string; update?: { state(): Promise<HostUpdate | null>; install(): Promise<boolean> } };
type Hooks = { updateEvent(name: string, info?: unknown): void };

/** A file as text, or null when there is none. */
const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);
const note = (hash: string, at: number) => JSON.stringify({ hash, at, from: "0.1.3" });
const version = (l: Launched) => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.version);
/** What the page heard on `on("update")`, in order (the fixture page listens on load). */
const heard = (l: Launched) => l.page.evaluate(() => (window as unknown as { __update: HostUpdate[] }).__update);
const updateState = (l: Launched) => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.update!.state());
const install = (l: Launched) => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.update!.install());
const installs = (l: Launched) => l.external().filter((line) => line === "update\tinstall");
/** A version downloaded and ready, as the feed would say it. */
const download = async (l: Launched, v: string) => {
  const events: [string, unknown?][] = [["checking-for-update"], ["update-available", { version: v }], ["update-downloaded", { version: v }]];
  for (const [name, info] of events) {
    await l.app.evaluate((_e, [n, i]) => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.updateEvent(n as string, i), [name, info] as const);
  }
};

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

/** Start a shell on `dir` and wait for the page. */
const start = async (dir?: string): Promise<Launched> => {
  l = await launch(origins.web, origins.api, dir ? { MAFOLD_DESKTOP_USER_DATA: dir } : {});
  await l.page.waitForSelector("#h");
  return l;
};

test("a restart into a new version opens on the conversation it left, and the note is used up", async () => {
  const dir = profile({ [RELAUNCH]: note(`#${CONV}`, Date.now() - 5_000) });
  const l = await start(dir);
  expect(l.page.url()).toBe(`${origins.web}/app#${CONV}`);
  expect(existsSync(join(dir, RELAUNCH))).toBe(false);
});

test("a hash the web app never writes (a markdown anchor) opens on the list", async () => {
  const dir = profile({ [RELAUNCH]: note("#section", Date.now() - 5_000) });
  const l = await start(dir);
  expect(l.page.url()).toBe(`${origins.web}/app`);
  expect(existsSync(join(dir, RELAUNCH))).toBe(false);
});

test("a note older than ten minutes opens on the list", async () => {
  const dir = profile({ [RELAUNCH]: note(`#${CONV}`, Date.now() - 11 * MIN) });
  const l = await start(dir);
  expect(l.page.url()).toBe(`${origins.web}/app`);
  expect(existsSync(join(dir, RELAUNCH))).toBe(false);
});

test("Restart writes down where the window was — the hash, never the query — and its place, at once; the next launch opens there", async () => {
  let l = await start();
  const dir = l.dirs.userData;
  // A page whose address carries a query (an OAuth callback's code=): it must
  // not be loaded again after the restart.
  await l.page.evaluate((c) => {
    location.href = `/app?code=abc#${c}`;
  }, CONV);
  await l.page.waitForURL((u) => u.search === "?code=abc" && u.hash === `#${CONV}`);
  await l.page.waitForSelector("#h");
  await download(l, "9.9.9");
  await expect.poll(() => updateState(l)).toMatchObject({ phase: "ready", next: "9.9.9" });

  // A move or a resize is saved half a second later (window.ts). Once that
  // has passed and the file is gone, only the restart itself can write it:
  // on macOS the window is closed before `before-quit`, too late to save there.
  const placeFile = join(dir, "window-state.json");
  await l.page.waitForTimeout(800);
  rmSync(placeFile, { force: true });

  const before = Date.now();
  expect(await install(l)).toBe(true);
  expect(installs(l)).toEqual(["update\tinstall"]);
  const raw = read(join(dir, RELAUNCH));
  expect(raw === null ? null : JSON.parse(raw)).toEqual({ hash: `#${CONV}`, at: expect.any(Number), from: await version(l) });
  expect(raw).not.toContain("code");
  const at = (JSON.parse(raw!) as { at: number }).at;
  expect(at).toBeGreaterThanOrEqual(before);
  expect(at).toBeLessThanOrEqual(Date.now());

  const place = read(placeFile);
  const bounds = await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getNormalBounds());
  expect(place === null ? null : JSON.parse(place)).toMatchObject({ bounds });

  // The new version starting (here: the same build, on the same profile).
  await l.app.close();
  l = await start(dir);
  expect(l.page.url()).toBe(`${origins.web}/app#${CONV}`);
  expect(existsSync(join(dir, RELAUNCH))).toBe(false);
});

test("the first run after updating tells the page which version it came from, and only that run", async () => {
  const dir = profile({ [LAST_VERSION]: "0.0.1\n" });
  let l = await start(dir);
  const v = await version(l);
  await expect.poll(() => heard(l)).toEqual([{ current: v, phase: "idle", updatedFrom: "0.0.1" }]);
  expect(await updateState(l)).toEqual({ current: v, phase: "idle", updatedFrom: "0.0.1" });
  expect(read(join(dir, LAST_VERSION))?.trim()).toBe(v);

  // The next launch of the same version has nothing to say.
  await l.app.close();
  l = await start(dir);
  await expect.poll(() => heard(l)).toEqual([{ current: v, phase: "idle" }]);
});

test("a shell with no version written down before it (a new install, or one from 0.1.3) says nothing about where it came from", async () => {
  const l = await start();
  const v = await version(l);
  await expect.poll(() => heard(l)).toEqual([{ current: v, phase: "idle" }]);
  expect(await updateState(l)).toEqual({ current: v, phase: "idle" });
  // …and writes this one down for the next.
  expect(read(join(l.dirs.userData, LAST_VERSION))?.trim()).toBe(v);
});
