import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

const CONV = "0f8fad5b-d9cb-469f-a165-70867728950e";

// Click through the DOM rather than `page.click`: the shell CANCELS these
// navigations (that is what is under test), and `page.click` waits for the
// navigation it scheduled to finish — forever, once it has been cancelled.
const clickLink = (l: Launched, id: string) => l.page.evaluate((i) => (document.getElementById(i) as HTMLAnchorElement).click(), id);

type TestHooks = {
  deepLink(url: string): void;
  trayLabels(): string[];
  unread(): { total: number };
  notificationsShown(): number;
  notifyPermission(): string;
  sawNotifyPermission(p: string): void;
  pendingAuth(): number;
};
const hooks = (l: Launched) => ({
  call: <T>(fn: (h: TestHooks) => T) =>
    l.app.evaluate((_electron, src) => {
      const h = (globalThis as unknown as { __mafoldTest: TestHooks }).__mafoldTest;
      return new Function("h", `return (${src})(h)`)(h);
    }, fn.toString()) as Promise<T>,
});

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

test("the web origin's page gets the bridge, with its capabilities", async () => {
  const host = await l.page.evaluate(() => {
    const h = (window as unknown as { mafoldHost?: { kind: string; caps: string[]; os: string; version: string } }).mafoldHost;
    return h ? { kind: h.kind, caps: [...h.caps], os: h.os, version: h.version } : null;
  });
  expect(host?.kind).toBe("desktop");
  expect(host?.caps).toEqual(expect.arrayContaining(["badge", "notify", "navigate", "commands", "oauth-external"]));
  // The page draws the window's lights on macOS only; elsewhere the frame is the system's.
  expect(host?.caps.includes("window-controls")).toBe(process.platform === "darwin");
  expect(host?.version).toMatch(/^\d+\.\d+\.\d+/);
});

test("a window closed to the tray is set to stop painting and keep its timers' pace", async () => {
  // Background throttling on: a hidden page is not drawn. Timer throttling
  // off: the socket's heartbeat and watchdog run on timers. The renderer keeps
  // its priority. (What that DOES can't be watched from here: Playwright's own
  // session keeps every page it drives "visible" — focus emulation counts as a
  // capture. It was measured by hand on macOS, hidden ≥15 min; see #794.)
  const wiring = await l.app.evaluate(({ app, BrowserWindow }) => ({
    throttling: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
    timers: app.commandLine.hasSwitch("disable-background-timer-throttling"),
    features: app.commandLine.getSwitchValue("disable-features"),
    backgrounding: app.commandLine.hasSwitch("disable-renderer-backgrounding"),
  }));
  expect(wiring).toEqual({ throttling: true, timers: true, features: expect.stringContaining("IntensiveWakeUpThrottling"), backgrounding: true });
});

test("frames inside the page never see the bridge", async () => {
  await expect.poll(() => l.page.evaluate(() => (window as unknown as { __frames: Record<string, unknown> }).__frames)).toEqual({
    card: { parent: "blocked", self: "undefined" },
    xo: "undefined",
  });
});

test("leaving the web origin goes to the system browser; the window stays", async () => {
  await clickLink(l, "ext");
  await expect.poll(() => l.external().join("\n")).toContain(`${origins.api}/elsewhere`);
  expect(l.page.url()).toBe(`${origins.web}/app`);

  await l.page.waitForTimeout(1100); // external opens are limited to one a second
  await l.page.evaluate((u) => window.open(u), "https://example.com/opened");
  await expect.poll(() => l.external().join("\n")).toContain("https://example.com/opened");
  expect(l.app.windows()).toHaveLength(1);
});

test("an api download lands in Downloads, and a second one does not overwrite it", async () => {
  await clickLink(l, "dl");
  const first = join(l.dirs.downloads, "report.txt");
  await expect.poll(() => existsSync(first)).toBe(true);
  await expect.poll(() => readFileSync(first, "utf8")).toBe("hello from the api");
  await clickLink(l, "dl");
  await expect.poll(() => existsSync(join(l.dirs.downloads, "report (1).txt"))).toBe(true);
  expect(l.page.url()).toBe(`${origins.web}/app`);
});

test("unread reaches the tray; a deep link reaches the page", async () => {
  await l.page.evaluate((id) => {
    (window as unknown as { mafoldHost: { setUnread(u: unknown): void } }).mafoldHost.setUnread({
      total: 4,
      top: [{ convId: id, title: "Design review", preview: "see you at 3", count: 4 }],
    });
  }, CONV);
  const h = hooks(l);
  await expect.poll(() => h.call((x) => x.unread().total)).toBe(4);
  await expect.poll(() => h.call((x) => x.trayLabels())).toEqual(expect.arrayContaining(["Design review  (4)"]));

  await l.app.evaluate((_e, url) => (globalThis as unknown as { __mafoldTest: TestHooks }).__mafoldTest.deepLink(url), `mafold://app#${CONV}`);
  await expect.poll(() => l.page.evaluate(() => (window as unknown as { __events: unknown[] }).__events)).toContainEqual(["navigate", `#${CONV}`]);
});

// Why the web's "Web push" row did nothing in the app: the page sees a service
// worker, PushManager and a granted permission — every check a browser passes —
// but Electron has no push service (ElectronBrowserContext::
// GetPushMessagingService returns null), so subscribing always fails.
test("Web Push cannot subscribe inside the shell, so the page must not offer it", async () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const probe = await l.page.evaluate(async (key) => {
    const r: Record<string, unknown> = {
      pushManager: "PushManager" in window,
      serviceWorker: "serviceWorker" in navigator,
      secure: window.isSecureContext,
      permission: await Notification.requestPermission(),
    };
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    try {
      const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      r.subscribed = true;
    } catch (e) {
      r.subscribed = false;
      r.error = `${(e as Error).name}: ${(e as Error).message}`;
    }
    return r;
  }, raw.toString("base64"));
  console.log("web push probe:", JSON.stringify(probe));
  expect(probe).toMatchObject({ pushManager: true, serviceWorker: true, secure: true, permission: "granted", subscribed: false });
  expect(String(probe.error)).toMatch(/AbortError|push service/i);
});

test("notify-settings: the page hears what the shell saw, and it survives a restart", async () => {
  type N = { permission(): Promise<string>; test(): Promise<string>; openSettings(): void };
  expect(await l.page.evaluate(() => {
    const h = (window as unknown as { mafoldHost: { caps: string[]; notifications?: unknown } }).mafoldHost;
    return h.caps.includes("notify-settings") && typeof h.notifications === "object";
  })).toBe(true);
  const permission = () => l.page.evaluate(() => (window as unknown as { mafoldHost: { notifications: N } }).mafoldHost.notifications.permission());

  // Nothing shown yet on a fresh profile.
  expect(await permission()).toBe("unknown");

  // A test notification settles to one of the three (xvfb has no notification
  // server, so which one depends on the runner) — it never hangs the page.
  const tested = await l.page.evaluate(() => (window as unknown as { mafoldHost: { notifications: N } }).mafoldHost.notifications.test());
  expect(["allowed", "blocked", "unknown"]).toContain(tested);

  // The system refused one: the page is told, and asking agrees.
  const h = hooks(l);
  await l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: TestHooks }).__mafoldTest.sawNotifyPermission("blocked"));
  await expect.poll(() => l.page.evaluate(() => (window as unknown as { __events: unknown[] }).__events)).toContainEqual(["notify-permission", "blocked"]);
  expect(await permission()).toBe("blocked");
  expect(await h.call((x) => x.notifyPermission())).toBe("blocked");

  // Kept across launches: a blocked app says so before the next message is lost.
  const userData = l.dirs.userData;
  await l.app.close();
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: userData });
  await l.page.waitForSelector("#h");
  expect(await permission()).toBe("blocked");
});

test("menu shortcuts reach the page as commands", async () => {
  await l.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === "New Chat") return i;
        const sub = i.submenu ? find(i.submenu.items) : undefined;
        if (sub) return sub;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()!.items);
    item!.click();
  });
  await expect.poll(() => l.page.evaluate(() => (window as unknown as { __events: unknown[] }).__events)).toContainEqual(["command", "new-chat"]);
});

test("OAuth: only the state the shell issued completes, and only once", async () => {
  const state = "dsk_e2e-state-0123456789";
  const pending = l.page.evaluate(
    (s) => (window as unknown as { mafoldHost: { oauth(u: string, s: string): Promise<unknown> } }).mafoldHost.oauth("https://provider.example/authorize?x=1", s),
    state,
  );
  await expect.poll(() => l.external().join("\n")).toContain("https://provider.example/authorize?x=1");
  const deliver = (url: string) => l.app.evaluate((_e, u) => (globalThis as unknown as { __mafoldTest: TestHooks }).__mafoldTest.deepLink(u), url);

  await deliver("mafold://link?code=FORGED&state=dsk_somebody-elses-state");
  await deliver(`mafold://link?code=GOOD&state=${state}`);
  await expect(pending).resolves.toEqual({ code: "GOOD" });
  expect(await hooks(l).call((x) => x.pendingAuth())).toBe(0);

  const bad = await l.page.evaluate(() =>
    (window as unknown as { mafoldHost: { oauth(u: string, s: string): Promise<unknown> } }).mafoldHost.oauth("https://provider.example/a", "not-desktop"),
  );
  expect(bad).toHaveProperty("error");
  const local = await l.page.evaluate(() =>
    (window as unknown as { mafoldHost: { oauth(u: string, s: string): Promise<unknown> } }).mafoldHost.oauth("file:///etc/passwd", "dsk_e2e-other-0123456789"),
  );
  expect(local).toHaveProperty("error");
});

test("a third-party popup is a child window without the bridge, and cannot drive the shell", async () => {
  const xo = l.page.frames().find((f) => f.url().startsWith(origins.api))!;
  const [child] = await Promise.all([l.app.waitForEvent("window"), xo.evaluate((u) => window.open(u), `${origins.api}/third`)]);
  await child.waitForSelector("#third");
  expect(await child.evaluate(() => typeof (window as unknown as { mafoldHost?: unknown }).mafoldHost)).toBe("undefined");

  // Even on the web origin, a child window's calls are not answered.
  await child.goto(`${origins.web}/app`);
  await child.waitForSelector("#h");
  await child.evaluate(() => (window as unknown as { mafoldHost?: { setUnread(u: unknown): void } }).mafoldHost?.setUnread({ total: 77, top: [] }));
  await l.page.waitForTimeout(500);
  expect(await hooks(l).call((x) => x.unread().total)).not.toBe(77);
});

test("no web origin reachable: the offline page, without a bridge", async () => {
  await l.app.close();
  l = await launch("http://127.0.0.1:9", origins.api);
  await l.page.waitForURL(/offline\.html/);
  await expect(l.page.locator("#title")).toHaveText("Can't reach Mafold");
  expect(await l.page.evaluate(() => typeof (window as unknown as { mafoldHost?: unknown }).mafoldHost)).toBe("undefined");
});
