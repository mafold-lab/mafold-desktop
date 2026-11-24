// The shell's own update, as the page sees it (the `update` cap). There is no
// update feed unpackaged, so the test feeds electron-updater's events itself
// (`updateEvent`) — the same names the real feed's go through — and a restart is
// written to externalLog as `update\tinstall` instead of quitting.

import { expect, test } from "@playwright/test";

import { apiFrame, launch, startOrigins, type Launched, type Origins } from "./fixtures";

type HostUpdate = { current: string; phase: string; next?: string; percent?: number; checkedAt?: number };
type Host = {
  version: string;
  caps: string[];
  on(ev: "update", cb: (u: HostUpdate) => void): () => void;
  update?: { state(): Promise<HostUpdate | null>; install(): Promise<boolean>; check(): Promise<HostUpdate | null> };
};
type Hooks = {
  updateEvent(name: string, info?: unknown): void;
  updateReady(): boolean;
  trayLabels(): string[];
  updateNotices(): number;
  updateNoticeClick(): void;
  subscribed(name: string): boolean;
};

const HIDDEN_ARG = "--hidden"; // autostart.ts (which imports electron: not loadable here)

const hooks = (l: Launched) => ({
  /** One of electron-updater's events, as the feed would send it. */
  event: (name: string, info?: unknown) =>
    l.app.evaluate((_e, [n, i]) => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.updateEvent(n as string, i), [name, info] as const),
  ready: () => l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.updateReady()),
  tray: () => l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.trayLabels()),
  /** How many times the shell decided to post "a new version is ready" (xvfb
   *  has no notification server to show one, so this is counted before asking). */
  notices: () => l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.updateNotices()),
  /** A click on that notification. */
  noticeClick: () => l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.updateNoticeClick()),
  /** Whether the shell has heard the page subscribe to `update` (the page's
   *  `on` reaches it over IPC, not before the test's next step). */
  listening: () => l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.subscribed("update")),
});
/** The main window is on screen: shown, not minimised. */
const onScreen = (l: Launched) =>
  l.app.evaluate(({ BaseWindow }) => {
    const w = BaseWindow.getAllWindows()[0];
    return w.isVisible() && !w.isMinimized();
  });
/** The main window is in front of the person: on screen, and the focused one. */
const inFront = (l: Launched) =>
  l.app.evaluate(({ BaseWindow }) => {
    const w = BaseWindow.getAllWindows()[0];
    return w.isVisible() && !w.isMinimized() && w.isFocused();
  });
/** Bring the main window to the front (`true`), or send it behind — as another
 *  app's window coming over it does — without hiding it (`false`). */
const putInFront = (l: Launched, front: boolean) =>
  l.app.evaluate(({ BaseWindow }, f) => {
    const w = BaseWindow.getAllWindows()[0];
    if (f) w.focus();
    else w.blur();
  }, front);
/** Whether the application menu has an item `label` — clicked, with `click`,
 *  the way shell.spec.ts clicks New Chat. */
const menuItem = (l: Launched, label: string, click = false) =>
  l.app.evaluate(
    ({ Menu }, [want, go]) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const i of items) {
          if (i.label === want) return i;
          const sub = i.submenu ? find(i.submenu.items) : undefined;
          if (sub) return sub;
        }
        return undefined;
      };
      const item = find(Menu.getApplicationMenu()!.items);
      if (item && go) item.click();
      return !!item;
    },
    [label, click] as const,
  );
const host = (l: Launched) => ({
  state: () => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.update!.state()),
  install: () => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.update!.install()),
  check: () => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.update!.check()),
});
/** What the page heard on `on("update")`, in order. */
const heard = (l: Launched) => l.page.evaluate(() => (window as unknown as { __update: HostUpdate[] }).__update);
const installs = (l: Launched) => l.external().filter((line) => line === "update\tinstall");

const download = async (l: Launched, version: string) => {
  const h = hooks(l);
  await h.event("checking-for-update");
  await h.event("update-available", { version });
  await h.event("download-progress", { percent: 37.5 });
  await h.event("update-downloaded", { version });
};

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
  await l.app.close();
});

test("a page that listens hears the state at once: idle, and nothing to restart into", async () => {
  const version = await l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.version);
  expect(await l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.caps.includes("update"))).toBe(true);
  await expect.poll(() => heard(l)).toEqual([{ current: version, phase: "idle" }]);
  expect(await host(l).state()).toEqual({ current: version, phase: "idle" });

  // No feed here: a check answers with the state as it is.
  expect(await host(l).check()).toEqual({ current: version, phase: "idle" });

  // Nothing downloaded: no restart, and the tray offers none.
  expect(await host(l).install()).toBe(false);
  expect(installs(l)).toEqual([]);
  expect(await hooks(l).ready()).toBe(false);
  expect(await hooks(l).tray()).not.toContain("Restart to Update");
});

test("a downloaded version reaches the page, the tray offers it, and the page may restart into it", async () => {
  await download(l, "9.9.9");
  await expect.poll(async () => (await heard(l)).at(-1)).toMatchObject({ phase: "ready", next: "9.9.9" });
  expect((await heard(l)).map((u) => u.phase)).toEqual(expect.arrayContaining(["idle", "checking", "downloading", "ready"]));
  expect(await host(l).state()).toMatchObject({ phase: "ready", next: "9.9.9" });
  expect(await hooks(l).ready()).toBe(true);
  await expect.poll(() => hooks(l).tray()).toContain("Restart to Update");

  // The four-hourly check again, and the same version downloaded again: no news.
  const before = (await heard(l)).length;
  await hooks(l).event("checking-for-update");
  await hooks(l).event("error", { message: "offline" });
  await hooks(l).event("update-downloaded", { version: "9.9.9" });
  await l.page.waitForTimeout(700); // longer than the progress window
  expect(await heard(l)).toHaveLength(before);
  expect(await host(l).state()).toMatchObject({ phase: "ready", next: "9.9.9" });

  expect(await host(l).install()).toBe(true);
  expect(installs(l)).toEqual(["update\tinstall"]);
});

test("a page that starts listening late gets the state as it is, not the history", async () => {
  await download(l, "9.9.9");
  await l.page.evaluate(() => {
    location.href = "/app?quiet"; // a new document, listening to nothing yet
  });
  await l.page.waitForURL("**/app?quiet");
  await l.page.waitForSelector("#h");
  expect(await heard(l)).toEqual([]);
  await l.page.evaluate(() => (window as unknown as { __listen(): void }).__listen());
  await expect.poll(() => heard(l)).toEqual([expect.objectContaining({ phase: "ready", next: "9.9.9" })]);
});

test("a second listener on the same page gets the state as it is too, and the first hears nothing twice", async () => {
  // The pill listens from the start; Settings ▸ Updates opens later and listens as well.
  await download(l, "9.9.9");
  await expect.poll(async () => (await heard(l)).at(-1)).toMatchObject({ phase: "ready", next: "9.9.9" });
  const before = (await heard(l)).length;
  await l.page.evaluate(() => {
    const w = window as unknown as { mafoldHost: Host; __update2: HostUpdate[] };
    w.__update2 = [];
    w.mafoldHost.on("update", (u) => w.__update2.push(u));
  });
  const second = () => l.page.evaluate(() => (window as unknown as { __update2: HostUpdate[] }).__update2);
  await expect.poll(second).toEqual([expect.objectContaining({ phase: "ready", next: "9.9.9" })]);
  expect(await heard(l)).toHaveLength(before);

  // From then on both hear every change.
  await hooks(l).event("update-downloaded", { version: "9.9.10" });
  await expect.poll(async () => (await second()).at(-1)).toMatchObject({ phase: "ready", next: "9.9.10" });
  expect(await second()).toHaveLength(2);
  expect(await heard(l)).toHaveLength(before + 1);
});

test("a child window on the web origin cannot restart the app or read the state", async () => {
  await download(l, "9.9.9");
  const xo = await apiFrame(l.page, origins.api);
  const [child] = await Promise.all([l.app.waitForEvent("window"), xo.evaluate((u) => window.open(u), `${origins.api}/third`)]);
  await child.waitForSelector("#third");
  await child.goto(`${origins.web}/app`);
  await child.waitForSelector("#h");
  const tried = await child.evaluate(async () => {
    const u = (window as unknown as { mafoldHost?: Host }).mafoldHost?.update;
    return u ? { state: await u.state(), install: await u.install() } : null;
  });
  // Refused by the bridge (fromOurPage), or no bridge at all.
  expect([null, { state: null, install: false }]).toContainEqual(tried);
  expect(installs(l)).toEqual([]);
});

// Who restarts when: the tray, the menu and the notification hand the restart
// to a page that listens (it knows whether an upload or a dictation would be
// cut off — it restarts at once otherwise); a page that listens to nothing
// (an older page, the offline page, one still loading, the pill switched off
// and its `off` called) or is on its way out (another document loading) gets
// today's restart at once. Not covered here: a page that stopped answering,
// which is the same as one that listens to nothing (test/updateState.spec.ts)
// — Chromium only calls a page hung after it has sat on input for many seconds.

test("in front, a page that listens says it with its pill: the shell posts no notification", async () => {
  await expect.poll(() => onScreen(l)).toBe(true); // a hidden window takes no focus
  await putInFront(l, true);
  await expect.poll(() => inFront(l)).toBe(true);
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await download(l, "9.9.9");
  await expect.poll(async () => (await heard(l)).at(-1)).toMatchObject({ phase: "ready", next: "9.9.9" });
  await hooks(l).event("checking-for-update");
  await hooks(l).event("update-downloaded", { version: "9.9.9" });
  expect(await hooks(l).notices()).toBe(0);
});

test("on screen but behind another app's window, it does post one, and a click only brings the window forward", async () => {
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await expect.poll(() => onScreen(l)).toBe(true);
  await putInFront(l, false);
  await expect.poll(() => inFront(l)).toBe(false);
  expect(await onScreen(l)).toBe(true); // not hidden, not minimised: only not in front
  await download(l, "9.9.9");
  // The pill is there, but nobody is looking at it.
  expect(await hooks(l).notices()).toBe(1);

  await expect.poll(async () => (await heard(l)).at(-1)).toMatchObject({ phase: "ready", next: "9.9.9" });
  const before = (await heard(l)).length;
  await hooks(l).noticeClick();
  await expect.poll(() => inFront(l)).toBe(true);
  // The page hears the state once more (its pill comes out), and nothing restarts.
  await expect.poll(async () => (await heard(l)).length).toBe(before + 1);
  expect((await heard(l)).at(-1)).not.toHaveProperty("ask");
  expect(installs(l)).toEqual([]);
});

test("in the tray it does post one, once per version, and a click only brings the window forward", async () => {
  await l.app.close();
  l = await launch(origins.web, origins.api, {}, [HIDDEN_ARG]);
  await l.page.waitForSelector("#h");
  expect(await onScreen(l)).toBe(false);
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await download(l, "9.9.9");
  expect(await hooks(l).notices()).toBe(1);
  // The four-hourly check finds the same file again: no second notification.
  await hooks(l).event("checking-for-update");
  await hooks(l).event("update-downloaded", { version: "9.9.9" });
  expect(await hooks(l).notices()).toBe(1);

  await expect.poll(async () => (await heard(l)).at(-1)).toMatchObject({ phase: "ready", next: "9.9.9" });
  const before = (await heard(l)).length;
  await hooks(l).noticeClick();
  await expect.poll(() => onScreen(l)).toBe(true);
  // The page hears the state once more (its pill comes out), and nothing restarts.
  await expect.poll(async () => (await heard(l)).length).toBe(before + 1);
  const told = (await heard(l)).at(-1)!;
  expect(told).toMatchObject({ phase: "ready", next: "9.9.9" });
  expect(told).not.toHaveProperty("ask");
  expect(installs(l)).toEqual([]);
});

test("a page that listens to nothing gets today's restart: the notification is posted, and a click restarts at once", async () => {
  await l.page.evaluate(() => {
    location.href = "/app?quiet";
  });
  await l.page.waitForURL("**/app?quiet");
  await l.page.waitForSelector("#h");
  await expect.poll(() => hooks(l).listening()).toBe(false);
  await expect.poll(() => onScreen(l)).toBe(true);
  await download(l, "9.9.9");
  expect(await hooks(l).notices()).toBe(1);
  await hooks(l).noticeClick();
  expect(installs(l)).toEqual(["update\tinstall"]);
});

test("the menu's Restart to Update asks a page that listens, and restarts nothing itself", async () => {
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await download(l, "9.9.9");
  await expect.poll(() => menuItem(l, "Restart to Update")).toBe(true);
  expect(await menuItem(l, "Restart to Update", true)).toBe(true);
  expect(installs(l)).toEqual([]);
  await expect.poll(async () => (await heard(l)).at(-1)).toEqual(expect.objectContaining({ phase: "ready", next: "9.9.9", ask: true }));
  // The ask rides that one event: the state the page asks for never carries it.
  expect(await host(l).state()).not.toHaveProperty("ask");
  // Nothing busy on the page: it restarts, the way its pill's button does.
  expect(await host(l).install()).toBe(true);
  expect(installs(l)).toEqual(["update\tinstall"]);
});

test("a page that listens to nothing: the menu's Restart to Update restarts at once, as before", async () => {
  await l.page.evaluate(() => {
    location.href = "/app?quiet";
  });
  await l.page.waitForURL("**/app?quiet");
  await l.page.waitForSelector("#h");
  await expect.poll(() => hooks(l).listening()).toBe(false);
  await download(l, "9.9.9");
  await expect.poll(() => menuItem(l, "Restart to Update")).toBe(true);
  expect(await menuItem(l, "Restart to Update", true)).toBe(true);
  expect(installs(l)).toEqual(["update\tinstall"]);
  expect(await heard(l)).toEqual([]);
});

test("a page that stops listening hands the restart back to the shell, and takes it again by listening again", async () => {
  // The pill comes and goes on one page (its switch turned off, its component
  // gone): it calls the `off` its `on` gave it.
  await l.page.evaluate(() => {
    location.href = "/app?quiet";
  });
  await l.page.waitForURL("**/app?quiet");
  await l.page.waitForSelector("#h");
  await download(l, "9.9.9");
  await expect.poll(() => menuItem(l, "Restart to Update")).toBe(true);
  const listen = () =>
    l.page.evaluate(() => {
      const w = window as unknown as { mafoldHost: Host; __update: HostUpdate[]; __off?: () => void };
      w.__off = w.mafoldHost.on("update", (u) => w.__update.push(u));
    });
  const stop = () => l.page.evaluate(() => (window as unknown as { __off(): void }).__off());

  await listen();
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await expect.poll(() => heard(l)).toEqual([expect.objectContaining({ phase: "ready", next: "9.9.9" })]);
  await stop();
  // The shell hears it: nobody on the page would take an ask now.
  await expect.poll(() => hooks(l).listening()).toBe(false);
  expect(await menuItem(l, "Restart to Update", true)).toBe(true);
  expect(installs(l)).toEqual(["update\tinstall"]);

  // Listening again: the shell answers with the state, and the menu asks again.
  await listen();
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await expect.poll(async () => (await heard(l)).length).toBe(2);
  expect(await menuItem(l, "Restart to Update", true)).toBe(true);
  await expect.poll(async () => (await heard(l)).at(-1)).toEqual(expect.objectContaining({ phase: "ready", next: "9.9.9", ask: true }));
  expect(installs(l)).toEqual(["update\tinstall"]); // still only the one before
});

test("a page on its way out (another document loading) cannot take the ask: the menu's Restart to Update restarts at once", async () => {
  await expect.poll(() => hooks(l).listening()).toBe(true);
  await download(l, "9.9.9");
  await expect.poll(() => menuItem(l, "Restart to Update")).toBe(true);
  void l.page.evaluate(() => {
    location.href = "/app?slow"; // takes 1.5 s to arrive
  });
  await l.page.waitForTimeout(300);
  // The old page still shows and is still subscribed — but an ask sent to it
  // now would leave with it, and the page replacing it would never hear it.
  expect(await hooks(l).listening()).toBe(true);
  expect(await menuItem(l, "Restart to Update", true)).toBe(true);
  expect(installs(l)).toEqual(["update\tinstall"]);
});
