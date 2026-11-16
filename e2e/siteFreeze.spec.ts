// A site tab put away goes still (cap `site-freeze`, src/main/siteFreeze.ts),
// in the real shell: the page asks for each site on its minimized page of tabs
// (mafold-web), the site's timers stop and what it plays is paused and muted,
// and it all comes back when the page does. The fixture page plays the page,
// as in siteAgent.spec.ts. Timing is generous: nothing here needs a tick to
// land on time, only a long silence while still and many ticks after.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

const SITE_PARTITION = "persist:mafold-sites";
/** How long the site stays still: longer than a hidden page's slowest timer
 *  (one a second), so only a frozen page goes this long without a tick. */
const STILL_MS = 2500;

let origins: Origins;
let l: Launched;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.afterEach(async () => {
  await l?.app.close();
});

async function open(): Promise<number> {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  await l.page.evaluate(
    (a) => {
      const w = document.createElement("webview");
      w.setAttribute("src", a.src);
      w.setAttribute("partition", a.partition);
      w.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px;display:flex";
      document.body.append(w);
    },
    { src: `${origins.api}/busy-site`, partition: SITE_PARTITION },
  );
  await expect.poll(() => guestUrl()).toContain("/busy-site");
  await expect.poll(() => run("document.readyState")).toBe("complete");
  return l.page.evaluate(() => (document.querySelector("webview") as unknown as { getWebContentsId(): number }).getWebContentsId());
}

const guestUrl = () =>
  l.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === "webview")?.getURL() ?? "");

/** In the site, from the shell (the page's tag can't run anything there).
 *  Never while it is still: nothing runs in a frozen page. */
const run = <T = unknown>(js: string): Promise<T> =>
  l.app.evaluate(
    ({ webContents }, code) => webContents.getAllWebContents().find((w) => w.getType() === "webview")!.mainFrame.executeJavaScript(code),
    js,
  ) as Promise<T>;

const muted = (): Promise<boolean> =>
  l.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === "webview")!.isAudioMuted());

const setMuted = (m: boolean): Promise<void> =>
  l.app.evaluate(({ webContents }, on) => webContents.getAllWebContents().find((w) => w.getType() === "webview")!.setAudioMuted(on), m);

/** The page's `mafoldHost.freezeSite(tab, frozen)`, `frozen` as given. */
const freezeSite = (tab: number, frozen: unknown): Promise<boolean> =>
  l.page.evaluate(
    ([t, f]) => (window as unknown as { mafoldHost: { freezeSite(t: number, f: unknown): Promise<boolean> } }).mafoldHost.freezeSite(t, f),
    [tab, frozen] as const,
  );

const playing = () => run<boolean>("!document.getElementById('v').paused");


test("the page offers it by capability", async () => {
  await open();
  const caps = await l.page.evaluate(() => (window as unknown as { mafoldHost: { caps: string[] } }).mafoldHost.caps);
  expect(caps).toContain("site-freeze");
  expect(await l.page.evaluate(() => typeof (window as unknown as { mafoldHost: { freezeSite?: unknown } }).mafoldHost.freezeSite)).toBe("function");
});

test("put away, a site stands still and silent; back, it runs and plays again", async () => {
  const tab = await open();
  await expect.poll(playing, { timeout: 10_000 }).toBe(true);
  const seen = await run<string>("document.visibilityState");
  expect(await muted()).toBe(false);
  await run("window.__maxGap = 0");

  expect(await freezeSite(tab, true)).toBe(true);
  expect(await muted()).toBe(true);
  // Asked again: the same answer, nothing more done.
  expect(await freezeSite(tab, true)).toBe(true);
  await l.page.waitForTimeout(STILL_MS);
  expect(await muted()).toBe(true);

  expect(await freezeSite(tab, false)).toBe(true);
  expect(await muted()).toBe(false);
  // While still, no timer ran: the longest wait between ticks is about as
  // long as it was put away. What the site and the shell saw goes with a
  // failure: the page's lifecycle events and the shell's freeze lines.
  const gap = await run<number>("window.__maxGap");
  if (gap <= STILL_MS * 0.6) {
    const logs = await l.app.evaluate(({ app }) => app.getPath("logs"));
    let lines = "";
    try {
      lines = readFileSync(join(logs, "main.log"), "utf8").split("\n").filter((s) => /site|froz|debugger/i.test(s)).join("\n");
    } catch (err) {
      lines = String(err);
    }
    console.log(`siteFreeze: gap ${gap}; site events ${JSON.stringify(await run("window.__events"))}; shell:\n${lines}`);
  }
  expect(gap).toBeGreaterThan(STILL_MS * 0.6);
  // Back: the timer runs at its own pace again (a page left hidden would tick
  // once a second), the video it paused plays, and the page is as visible as
  // it was.
  const ticks = await run<number>("window.__ticks");
  const pace = seen === "visible" ? 10 : 0;
  await expect.poll(() => run<number>("window.__ticks"), { timeout: 4000 }).toBeGreaterThan(ticks + pace);
  expect(await run<number>("window.__pauses")).toBeGreaterThan(0);
  await expect.poll(playing, { timeout: 5000 }).toBe(true);
  await expect.poll(() => run<string>("document.visibilityState"), { timeout: 5000 }).toBe(seen);
  expect(await freezeSite(tab, false)).toBe(true);
});

test("a tab muted before stays muted", async () => {
  const tab = await open();
  await setMuted(true);
  expect(await freezeSite(tab, true)).toBe(true);
  expect(await freezeSite(tab, false)).toBe(true);
  expect(await muted()).toBe(true);
});

test("only the page's own site tabs, and only a yes or no", async () => {
  const tab = await open();
  expect(await freezeSite(999_999, true)).toBe(false);
  // The page itself is not a site.
  const pageId = await l.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() !== "webview" && w.getURL().includes("127.0.0.1"))!.id);
  expect(await freezeSite(pageId, true)).toBe(false);
  expect(await freezeSite(tab, "yes")).toBe(false);
  expect(await muted()).toBe(false);

  // Still, then gone: there is nothing to bring back.
  expect(await freezeSite(tab, true)).toBe(true);
  await l.page.evaluate(() => document.querySelector("webview")?.remove());
  await expect.poll(() => guestUrl()).toBe("");
  expect(await freezeSite(tab, false)).toBe(false);
});
