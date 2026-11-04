// A link on the desktop app, end to end: the real screens (mafold-web
// test/windowLights, the shots page) in the real shell. A link in the chat
// becomes a tab on the app page, the site in it says who it is, the address
// row drives it, ⤢ doesn't reload it. sites.spec.ts is what a site may do;
// this is the page around it. The pictures it takes go up with the suite's.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";
import { captureWindow } from "./os/real";

const WEB_DIR = process.env.MAFOLD_DESKTOP_SHOTS_PAGE ?? join(__dirname, "web");
const HAVE_PAGE = existsSync(join(WEB_DIR, "index.html")) && existsSync(join(WEB_DIR, "harness.js"));
test.skip(!HAVE_PAGE, `no shots page at ${WEB_DIR} (the monorepo's desktop-tests.yml builds it: scripts/ci/public-desktop/shots-page.mjs)`);

const LAYOUT = { signedIn: true, chat: true, flags: { appBeside: true, inAppBrowser: true } };
const path = (layout: unknown) => `/app?layout=${encodeURIComponent(JSON.stringify(layout))}`;

let origins: Origins;
let server: Server;
let web = "";
let l: Launched;
let page: Page;
let OUT = "";

test.beforeAll(async () => {
  origins = await startOrigins();
  const js = readFileSync(join(WEB_DIR, "harness.js"));
  const html = readFileSync(join(WEB_DIR, "index.html"));
  server = createServer((req, res) => {
    if (req.url?.startsWith("/harness.js")) res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" }).end(js);
    else if (req.url?.startsWith("/app")) res.writeHead(200, { "content-type": "text/html" }).end(html);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  web = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  OUT = join(test.info().project.outputDir, "site-tabs");
  mkdirSync(OUT, { recursive: true });
});
test.afterAll(async () => {
  await origins?.close();
  await new Promise((r) => server?.close(r));
});
test.beforeEach(async () => {
  l = await launch(web, "http://127.0.0.1:9", { MAFOLD_DESKTOP_START_PATH: path(LAYOUT) });
  page = l.page;
  await page.waitForFunction(() => !!(window as unknown as { __lights?: unknown }).__lights, null, { timeout: 30_000 });
  await page.getByText("Peer", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(1440, 900));
  await page.waitForFunction(() => innerWidth >= 1024);
});
test.afterEach(async () => {
  await l.app.close();
});

const url = (p: string) => `${origins.api}${p}`;

/** A link in the chat, the shape Markdown and RichText give every link. */
const tap = async (href: string, id = "the-link") => {
  await page.evaluate(
    ({ href, id }) => {
      document.getElementById(id)?.remove();
      const a = document.createElement("a");
      a.id = id;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "a link in a message";
      a.style.cssText = "position:fixed;left:380px;bottom:120px;z-index:9;background:var(--jBubble);padding:8px";
      document.body.append(a);
    },
    { href, id },
  );
  await settle(300); // tabs are limited to four a second (security.ts)
  await page.click(`#${id}`);
};

const tabs = () => page.locator("[data-app-tab]");
const openTab = () => page.locator("[data-app-tab][aria-selected='true']");
const guests = () =>
  l.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getType() === "webview").map((w) => ({ id: w.id, url: w.getURL() })));
const run = <T = unknown>(id: number, js: string): Promise<T> =>
  l.app.evaluate(({ webContents }, a) => webContents.fromId(a.id)!.mainFrame.executeJavaScript(a.js), { id, js }) as Promise<T>;
async function guestOn(p: string): Promise<number> {
  await expect.poll(async () => (await guests()).some((g) => g.url === url(p))).toBe(true);
  return (await guests()).find((g) => g.url === url(p))!.id;
}
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
/** The window as it is on screen, guests and all. Linux has no capture of its
 *  own in the suite (os/real.ts); the system's picture of the window does. */
const shot = async (name: string) => {
  const file = join(OUT, `${name}.png`);
  if ((await captureWindow(l.app, file)).ok) return;
  const png = await l.app.evaluate(async ({ BaseWindow, desktopCapturer }) => {
    const w = BaseWindow.getAllWindows()[0];
    const sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: w.getBounds(), fetchWindowIcons: false });
    return (sources.find((s) => s.id === w.getMediaSourceId()) ?? sources[0])?.thumbnail.toPNG().toString("base64") ?? "";
  });
  if (png) writeFileSync(file, Buffer.from(png, "base64"));
};

test("a link opens as a tab on the app page, and the site says who it is", async () => {
  await tap(url("/titled"));
  await expect(openTab()).toContainText("The site's own title");
  await guestOn("/titled");
  await expect(page.getByTestId("site-bar")).toContainText("/titled");
  await expect(openTab().locator("img")).toBeVisible();
  // The way an app opens: the list folds, the chat moves over, nothing asked
  // of the system browser.
  await expect(page.getByTestId("app-panel")).toBeVisible();
  expect(l.external()).toEqual([]);
  await settle();
  await shot("1-beside");
});

test("⤢ and back again keep the site where it was: no reload", async () => {
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await run(id, "window.__same = 'still here'");
  await page.getByRole("button", { name: "Fill the window" }).click();
  await settle(900);
  await shot("2-full");
  expect(await run(id, "window.__same")).toBe("still here");
  await page.getByRole("button", { name: "Put it beside the chat" }).click();
  await settle(900);
  expect(await run(id, "window.__same")).toBe("still here");
  expect((await guests()).map((g) => g.id)).toEqual([id]);
  await expect(page.getByTestId("app-panel")).toBeVisible();
});

test("putting the page away keeps the site too: a thread over it, then back", async () => {
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await run(id, "window.__same = 'still here'");
  const lights = (name: string) => page.evaluate((n) => (window as unknown as { __lights: Record<string, () => void> }).__lights[n](), name);
  await lights("thread");
  await settle();
  await expect(page.locator("webview")).toBeHidden();
  await lights("closeDock");
  await expect(page.locator("webview")).toBeVisible();
  expect(await run(id, "window.__same")).toBe("still here");
});

test("the same link goes back to its tab; another link is another tab", async () => {
  await tap(url("/titled"));
  await guestOn("/titled");
  await tap(url("/site"), "second");
  await guestOn("/site");
  await expect(tabs()).toHaveCount(2);
  await settle();
  await tap(url("/titled"));
  await expect(tabs()).toHaveCount(2);
  await expect(openTab()).toContainText("The site's own title");
  expect(await guests()).toHaveLength(2);
  await shot("3-two-tabs");
});

test("a tab can go and come back by the address row", async () => {
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  const back = page.getByRole("button", { name: "Back" });
  const forward = page.getByRole("button", { name: "Forward" });
  await expect(back).toBeDisabled();
  await page.getByLabel("Address").click();
  await page.getByLabel("Address").fill(url("/next"));
  await page.keyboard.press("Enter");
  await expect(openTab()).toContainText("The next page");
  await expect(page.getByTestId("site-bar")).toContainText("/next");
  await expect(back).toBeEnabled();
  await back.click();
  await expect(openTab()).toContainText("The site's own title");
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(openTab()).toContainText("The next page");
  await run(id, "window.__same = 1");
  await page.getByRole("button", { name: "Reload" }).click();
  // A script that lands as the document goes never answers, so ask again.
  await expect.poll(() => Promise.race([run(id, "window.__same === undefined"), settle(300).then(() => false)])).toBe(true);
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // A link the site follows on its own moves the address with it.
  await run(id, `document.querySelector("#next").click()`);
  await expect(page.getByTestId("site-bar")).toContainText("/next");
});

test("the + box opens any site, and a search for anything else", async () => {
  await tap(url("/titled"));
  await guestOn("/titled");
  await page.getByRole("button", { name: "Apps" }).click();
  const box = page.getByPlaceholder("Search or enter a web address");
  await expect(box).toBeVisible();
  // At 200 ms the Mac runner's picture was still the site loading, with no menu.
  await settle(1200);
  await shot("4-plus");
  await box.fill(url("/next"));
  await page.keyboard.press("Enter");
  await guestOn("/next");
  await expect(tabs()).toHaveCount(2);
});

test("a site that won't load says so, and can try again", async () => {
  await tap("http://127.0.0.1:9/nothing-here");
  await expect(page.getByText("This page didn't open")).toBeVisible();
  await settle();
  await shot("5-failed");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("This page didn't open")).toBeVisible();
  expect(l.external()).toEqual([]);
});

test("the button hands the page to the default browser, says so, and keeps the tab", async () => {
  await tap(url("/titled"));
  await guestOn("/titled");
  const out = page.getByRole("button", { name: "Open in your default browser" });
  await expect(out.getByText("Open in your default browser")).toBeVisible();
  await settle();
  await shot("7-button");
  await out.click();
  await expect.poll(() => l.external().join("\n")).toContain(url("/titled"));
  await expect(tabs()).toHaveCount(1);
  // Where the row is short the address needs the room: the icon stays.
  await page.getByRole("button", { name: "Fill the window" }).waitFor();
  await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(520, 820));
  await page.waitForFunction(() => innerWidth < 600);
  await expect(out.getByText("Open in your default browser")).toBeHidden();
  await expect(out).toBeVisible();
});

const lights = (name: string, ...args: unknown[]) =>
  page.evaluate(([n, a]) => (window as unknown as { __lights: Record<string, (...x: unknown[]) => void> }).__lights[n as string](...(a as unknown[])), [name, args]);

// `payments.openWeb` takes https only, which the fixtures don't speak: this one
// doesn't load, and it doesn't have to. Where it opens is the point.
const CHECKOUT = "https://checkout.invalid/c/pay/cs_test#token=tok";

// What the page shows after a navigation the shell cancelled, asked by script:
// Playwright's locators wait for that navigation to finish, which it never does.
const count = (selector: string) => page.evaluate((s) => document.querySelectorAll(s).length, selector);
const reads = () => page.evaluate(() => document.body.innerText);
const siteShown = () =>
  page.evaluate(() => {
    const tag = document.querySelector("webview");
    return !!tag && getComputedStyle(tag).visibility === "visible" && tag.getBoundingClientRect().width > 200;
  });

test("a checkout opens as a tab, and the sheets it was bought from give way", async () => {
  await lights("sheet");
  await lights("cardModal");
  await expect(page.getByTestId("harness-sheet")).toBeVisible();
  await expect(page.getByText("Harness card")).toBeVisible();
  await lights("pay", CHECKOUT);
  await expect.poll(reads).toContain("checkout.invalid");
  expect(await reads()).toContain("#token=tok"); // Waffo's session is in the fragment
  expect(await count("[data-app-tab]")).toBe(1);
  await expect.poll(() => count("[data-testid=harness-sheet]")).toBe(0);
  await expect.poll(reads).not.toContain("Harness card");
  await expect.poll(siteShown).toBe(true);
  expect(l.external()).toEqual([]);
});

test("a checkout from Settings: Settings gives way too", async () => {
  await lights("settings", "general");
  await expect(page.getByTestId("site-bar")).toHaveCount(0);
  await lights("pay", CHECKOUT);
  await expect.poll(reads).toContain("checkout.invalid");
  await expect.poll(siteShown).toBe(true);
});

test("an app filling the window gives way too", async () => {
  await lights("appFull");
  await expect(page.locator("[data-app-tab]")).toHaveCount(0);
  await page.evaluate((u) => void window.open(u, "_blank", "noopener,noreferrer"), url("/titled"));
  await guestOn("/titled");
  await expect(page.locator("webview")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(1000, 500)?.tagName)).toBe("WEBVIEW");
});

test("back from a checkout: the tab ends, before the app's sign-in page shows, and the reader is told", async () => {
  await lights("noteCheckout", url("/titled"));
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await run(id, `location.href = ${JSON.stringify(`${web}/app?premium=success`)}`);
  await expect(tabs()).toHaveCount(0);
  await expect.poll(() => guests()).toEqual([]);
  await expect(page.getByText("Payment done.")).toBeVisible();
  expect(l.external()).toEqual([]);
});

test("back from a checkout by a redirect, or without paying: the tab ends, nothing is claimed", async () => {
  await lights("noteCheckout", url("/titled"));
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await run(id, `location.href = ${JSON.stringify(url(`/redirect?to=${encodeURIComponent(`${web}/app?topup=cancel`)}`))}`);
  await expect(tabs()).toHaveCount(0);
  await expect.poll(() => guests()).toEqual([]);
  await expect(page.getByText("Payment done.")).toHaveCount(0);
});

test("any other site going to that address: the tab ends too, but it can't say it was paid", async () => {
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await run(id, `location.href = ${JSON.stringify(`${web}/app?premium=success`)}`);
  await expect(tabs()).toHaveCount(0);
  await settle();
  await expect(page.getByText("Payment done.")).toHaveCount(0);
});

test("the page sent off to the web, a plain link, a sized popup: all tabs", async () => {
  await page.evaluate((u) => location.assign(u), url("/titled"));
  await guestOn("/titled");
  await settle(300);
  await page.evaluate((u) => {
    const a = document.createElement("a");
    a.href = u;
    document.body.append(a);
    a.click();
    a.remove();
  }, url("/next"));
  await guestOn("/next");
  await settle(300);
  await page.evaluate((u) => void window.open(u, "_blank", "width=500,height=500"), url("/site"));
  await guestOn("/site");
  expect(await count("[data-app-tab]")).toBe(3);
  expect(l.external()).toEqual([]);
});

test("with the Settings switch on, a checkout goes to the default browser", async () => {
  await page.evaluate(() => {
    localStorage.setItem("mafold.links.browser.v1", "1");
    window.dispatchEvent(new Event("mafold:links"));
  });
  await lights("pay", CHECKOUT);
  await expect.poll(() => l.external().join("\n")).toContain(CHECKOUT);
  expect(await count("[data-app-tab]")).toBe(0);
});

test("× closes the tab; the last one closes the page and the chat is back", async () => {
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await page.getByRole("button", { name: "Close" }).nth(1).click();
  await expect(tabs()).toHaveCount(0);
  await expect.poll(() => guests()).toEqual([]);
  expect(id).toBeGreaterThan(0);
});

test("keys pressed in a site: ⌘L goes to the address, ⌘W closes the tab", async () => {
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  const press = (keyCode: string) =>
    l.app.evaluate(
      ({ webContents }, a) => {
        const w = webContents.fromId(a.id)!;
        w.focus();
        // The original: the guest's own is sealed against the page (sites.ts).
        const send = Object.getPrototypeOf(w).sendInputEvent.bind(w) as Electron.WebContents["sendInputEvent"];
        send({ type: "keyDown", keyCode: a.keyCode, modifiers: [a.mod as "control"] });
        send({ type: "keyUp", keyCode: a.keyCode, modifiers: [a.mod as "control"] });
      },
      { id, keyCode, mod: process.platform === "darwin" ? "meta" : "control" },
    );
  await press("l");
  await expect(page.locator("input[aria-label='Address']")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("input[aria-label='Address']")).toHaveCount(0);
  await expect(tabs()).toHaveCount(1); // Escape stopped at the box
  await press("w");
  await expect(tabs()).toHaveCount(0);
});

test("the Settings switch sends links to the default browser", async () => {
  await page.evaluate(() => {
    localStorage.setItem("mafold.links.browser.v1", "1");
    window.dispatchEvent(new Event("mafold:links"));
  });
  await tap(url("/titled"));
  await expect.poll(() => l.external().join("\n")).toContain(url("/titled"));
  await expect(tabs()).toHaveCount(0);
});

test("a link to the app itself stays in the app: no tab, no system browser", async () => {
  await tap(`${web}/app#moments`);
  await page.waitForFunction(() => location.hash === "#moments" || document.querySelector("[data-testid=moments]") !== null, null, { timeout: 5000 }).catch(() => {});
  await settle();
  await expect(tabs()).toHaveCount(0);
  expect(l.external()).toEqual([]);
});

test("a narrow window: the page covers the chat", async () => {
  await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(700, 820));
  await page.waitForFunction(() => innerWidth < 1024);
  await tap(url("/titled"));
  const id = await guestOn("/titled");
  await expect(openTab()).toContainText("The site's own title");
  await settle(900);
  await shot("6-narrow");
  await run(id, "window.__same = 'still here'");
  await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(1440, 900));
  await settle(900);
  expect(await run(id, "window.__same")).toBe("still here");
});
