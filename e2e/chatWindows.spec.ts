// A conversation in a window of its own, in the real shell: who may open one,
// what the page in it is told and can reach, and what happens when it closes or
// Mafold quits. The fixture page plays the web app.

import { existsSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CH = "33333333-3333-4333-8333-333333333333";

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

declare const mafoldHost: {
  caps: string[];
  soloChat?: string;
  soloChannel?: string;
  openChatWindow(c: string, dropped?: boolean, channel?: string): void;
  closeChatWindow(): void;
  setUnread(u: unknown): void;
};

const open = () => l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: { chatWindows(): string[] } }).__mafoldTest.chatWindows());

async function pageOf(conv: string): Promise<Page> {
  await expect.poll(() => l.app.windows().some((p) => p.url().endsWith(`#${conv}`))).toBe(true);
  const page = l.app.windows().find((p) => p.url().endsWith(`#${conv}`))!;
  await page.waitForSelector("#h");
  return page;
}

/** Every window on `conv`, by what it says it shows; "" for the whole conversation. */
async function shownOf(conv: string): Promise<string[]> {
  const pages = l.app.windows().filter((p) => p.url().endsWith(`#${conv}`));
  return (await Promise.all(pages.map((p) => p.evaluate(() => mafoldHost.soloChannel ?? "")))).sort();
}

// The window can be gone before the evaluate that closed it reports back, so that
// rejection says nothing: the caller checks the window really went.
const closeFrom = (p: Page) => p.evaluate(() => mafoldHost.closeChatWindow()).catch(() => {});

test("the page opens a conversation in its own window, which knows what it is", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  const solo = await pageOf(A);
  expect(await open()).toEqual([A]);
  expect(await solo.evaluate(() => mafoldHost.soloChat)).toBe(A);
  expect(await solo.evaluate(() => mafoldHost.soloChannel)).toBeUndefined();
  expect(await solo.evaluate(() => [...mafoldHost.caps].sort())).toEqual(["chat-channel-windows", "chat-windows", "external-links", "notify"]);
  // The main page isn't one.
  expect(await l.page.evaluate(() => mafoldHost.soloChat)).toBeUndefined();
  expect(await l.page.evaluate(() => mafoldHost.caps.includes("chat-windows"))).toBe(true);
});

test("opening it again brings up the same window", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  await pageOf(A);
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  await l.page.waitForTimeout(300);
  expect(await open()).toEqual([A]);
  expect(l.app.windows().filter((p) => p.url().endsWith(`#${A}`))).toHaveLength(1);
});

test("several stand at once, each where it was dropped", async () => {
  await l.app.evaluate((_e, [a, b]) => {
    const t = (globalThis as unknown as { __mafoldTest: { openChatWindow(c: string, at?: { x: number; y: number }): void } }).__mafoldTest;
    t.openChatWindow(a, { x: 300, y: 100 });
    t.openChatWindow(b, { x: 800, y: 100 });
  }, [A, B]);
  await pageOf(A);
  await pageOf(B);
  const bounds = await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("#")).map((w) => w.getBounds()));
  expect(bounds).toHaveLength(2);
  // Kept on the screen: CI's Mac is 1024 wide, which leaves a 760 window 264 to move in.
  expect(Math.abs(bounds[0].x - bounds[1].x)).toBeGreaterThanOrEqual(200);
});

test("nothing but a conversation's id opens one", async () => {
  await l.page.evaluate(() => mafoldHost.openChatWindow("../settings"));
  await l.page.evaluate(() => (mafoldHost.openChatWindow as (c: unknown) => void)(42));
  await l.page.waitForTimeout(300);
  expect(await open()).toEqual([]);
});

test("one conversation stands in several windows, a channel in each, beside the whole of it", async () => {
  await l.page.evaluate(([c, ch]) => {
    mafoldHost.openChatWindow(c);
    mafoldHost.openChatWindow(c, false, ch);
    mafoldHost.openChatWindow(c, false, "all");
  }, [A, CH]);
  await expect.poll(open).toHaveLength(3);
  await pageOf(A);
  await expect.poll(() => shownOf(A)).toEqual(["", CH, "all"].sort());
  // The same channel again is the same window.
  await l.page.evaluate(([c, ch]) => mafoldHost.openChatWindow(c, false, ch), [A, CH]);
  await l.page.waitForTimeout(300);
  expect(await open()).toHaveLength(3);
});

test("a conversation's window sends its channels to windows of their own", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  const solo = await pageOf(A);
  await solo.evaluate(([c, ch]) => mafoldHost.openChatWindow(c, true, ch), [A, CH]);
  await expect.poll(open).toEqual([A, `${A}/${CH}`]);
});

test("a channel that is no channel opens the whole conversation", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c, false, "../settings"), A);
  await pageOf(A);
  expect(await open()).toEqual([A]);
});

test("a conversation's window can't speak for the main one", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  const solo = await pageOf(A);
  await solo.evaluate(() => mafoldHost.setUnread({ total: 7, top: [] }));
  await solo.waitForTimeout(300);
  const unread = await l.app.evaluate(() => (globalThis as unknown as { __mafoldTest: { unread(): { total: number } } }).__mafoldTest.unread().total);
  expect(unread).toBe(0);
});

test("a site can't be put on a tab in it", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  const solo = await pageOf(A);
  const created = await solo.evaluate((src) => {
    const w = document.createElement("webview");
    w.setAttribute("src", src);
    w.setAttribute("partition", "persist:mafold-sites");
    document.body.append(w);
    return typeof (w as unknown as { loadURL?: unknown }).loadURL;
  }, `${origins.api}/elsewhere`);
  expect(created).toBe("undefined");
});

test("it closes for real, from its own page; the main window stays", async () => {
  await l.page.evaluate((c) => mafoldHost.openChatWindow(c), A);
  const solo = await pageOf(A);
  await closeFrom(solo);
  await expect.poll(open).toEqual([]);
  expect(await l.page.evaluate(() => document.title)).toBeTruthy();
});

test("signing out in the main window closes them all", async () => {
  await l.page.evaluate(([a, b]) => {
    mafoldHost.openChatWindow(a);
    mafoldHost.openChatWindow(b);
  }, [A, B]);
  await pageOf(A);
  await pageOf(B);
  await l.page.evaluate(() => mafoldHost.closeChatWindow());
  await expect.poll(open).toEqual([]);
});

test("the ones open at quit come back at the next launch, where they were; one closed doesn't", async () => {
  await l.page.evaluate(([a, b]) => {
    mafoldHost.openChatWindow(a);
    mafoldHost.openChatWindow(b);
  }, [A, B]);
  await pageOf(A);
  const solo = await pageOf(B);
  await closeFrom(solo);
  await expect.poll(open).toEqual([A]);
  const was = await l.app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(`#${c}`))!.setBounds({ x: 222, y: 111, width: 500, height: 600 }), A);
  expect(was).toBeUndefined();
  await new Promise((r) => setTimeout(r, 800));
  const userData = l.dirs.userData;
  expect(existsSync(`${userData}/chat-windows.json`)).toBe(true);
  await l.app.close();

  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_USER_DATA: userData });
  await pageOf(A);
  expect(await open()).toEqual([A]);
  const back = await l.app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(`#${c}`))!.getBounds(), A);
  expect(back).toMatchObject({ width: 500, height: 600 });
});
