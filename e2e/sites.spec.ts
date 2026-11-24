// A site on a tab of the page, in the real shell: a `<webview>` of the page
// (mafold-web components/SiteView.tsx). Who may have one, what it runs with,
// what it can reach, and where every way out of it goes. The fixture page plays
// the page: each test adds the tag the way SiteView does.

import { expect, test } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

const SITE_PARTITION = "persist:mafold-sites";
const SITE_INCOGNITO_PARTITION = "mafold-sites-incognito";

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

type Attrs = Record<string, string>;

/** The tag on the page, under the fold-free top left of the window. */
const addTag = (attrs: Attrs) =>
  l.page.evaluate((a) => {
    document.querySelector("webview")?.remove();
    const w = document.createElement("webview");
    for (const [k, v] of Object.entries(a)) w.setAttribute(k, v);
    w.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px;display:flex";
    document.body.append(w);
  }, attrs);

const site = (over: Attrs = {}) => ({ src: `${origins.api}/site`, partition: SITE_PARTITION, allowpopups: "", ...over });

const guests = () =>
  l.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getType() === "webview").map((w) => ({ id: w.id, url: w.getURL() })));

/** The one site on the page, loaded. */
async function loaded(path = "/site"): Promise<number> {
  await expect.poll(async () => (await guests()).find((g) => g.url.endsWith(path))?.url).toBeTruthy();
  const { id } = (await guests()).find((g) => g.url.endsWith(path))!;
  await expect.poll(() => run(id, "document.readyState")).toBe("complete");
  return id;
}

const run = <T = unknown>(id: number, js: string): Promise<T> =>
  l.app.evaluate(({ webContents }, a) => webContents.fromId(a.id)!.mainFrame.executeJavaScript(a.js), { id, js }) as Promise<T>;

/** A real press on an element of the site, by the input path the person's own
 *  takes: what lets it open anything (security.ts). */
async function press(id: number, el: string, modifiers: string[] = []): Promise<void> {
  const at = await run<{ x: number; y: number }>(
    id,
    `(() => { const r = document.querySelector(${JSON.stringify(el)}).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()`,
  );
  await l.app.evaluate(
    ({ webContents }, a) => {
      const w = webContents.fromId(a.id)!;
      w.focus();
      const ev = { x: a.at.x, y: a.at.y, button: "left" as const, clickCount: 1, modifiers: a.modifiers as Electron.InputEvent["modifiers"] };
      // The original: the guest's own is sealed against the page (sites.ts).
      const send = Object.getPrototypeOf(w).sendInputEvent.bind(w) as Electron.WebContents["sendInputEvent"];
      send({ type: "mouseMove", x: a.at.x, y: a.at.y });
      send({ ...ev, type: "mouseDown" });
      send({ ...ev, type: "mouseUp" });
    },
    { id, at, modifiers },
  );
}

/** The page listening: what makes links come to it. */
const takeLinks = () =>
  l.page.evaluate(() => {
    const host = (window as unknown as { mafoldHost: { on(e: string, cb: (u: string) => void): () => void } }).mafoldHost;
    const w = window as unknown as { __links: string[]; __stopLinks: () => void };
    w.__links = [];
    w.__stopLinks = host.on("open-link", (u) => w.__links.push(u));
  });
const links = () => l.page.evaluate(() => (window as unknown as { __links: string[] }).__links);

const refused = async () => {
  await l.page.waitForTimeout(600);
  expect(await guests()).toHaveLength(0);
};

test("the shell offers site tabs on every system", async () => {
  const caps = await l.page.evaluate(() => [...(window as unknown as { mafoldHost: { caps: string[] } }).mafoldHost.caps]);
  expect(caps).toContain("site-tabs");
  expect(caps).toContain("site-incognito");
});

test.describe("incognito tabs", () => {
  /** One more tag, leaving the others where they are. */
  const addSecond = (attrs: Attrs) =>
    l.page.evaluate((a) => {
      const w = document.createElement("webview");
      for (const [k, v] of Object.entries(a)) w.setAttribute(k, v);
      w.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px;display:flex";
      document.body.append(w);
    }, attrs);
  const dropTags = () => l.page.evaluate(() => document.querySelectorAll("webview").forEach((w) => w.remove()));
  const cookies = () =>
    l.app.evaluate(async ({ session }, partition) => (await session.fromPartition(partition).cookies.get({})).map((c) => c.name), SITE_INCOGNITO_PARTITION);

  test("the session lives in memory and shares nothing with the sites'", async () => {
    await addTag(site());
    const plain = await loaded();
    await run(plain, `document.cookie = "plain=1; path=/"`);
    await addSecond(site({ src: `${origins.api}/opened`, partition: SITE_INCOGNITO_PARTITION }));
    const hidden = await loaded("/opened");
    expect(await run(hidden, "document.cookie")).not.toContain("plain=1");
    await run(hidden, `document.cookie = "hidden=1; path=/"`);
    expect(await run(plain, "document.cookie")).not.toContain("hidden=1");
    const memory = await l.app.evaluate(({ session }, partition) => {
      const s = session.fromPartition(partition);
      return { persistent: s.isPersistent(), path: s.storagePath };
    }, SITE_INCOGNITO_PARTITION);
    expect(memory).toEqual({ persistent: false, path: null });
  });

  test("stays while one tab is left, and is gone when the last one closes", async () => {
    await addTag(site({ partition: SITE_INCOGNITO_PARTITION }));
    const first = await loaded();
    await run(first, `document.cookie = "hidden=1; path=/"; localStorage.setItem("hidden", "1")`);
    await addSecond(site({ src: `${origins.api}/opened`, partition: SITE_INCOGNITO_PARTITION }));
    const second = await loaded("/opened");
    await l.page.evaluate(() => document.querySelector("webview")?.remove());
    await expect.poll(async () => (await guests()).length).toBe(1);
    expect(await run(second, "document.cookie")).toContain("hidden=1");

    await dropTags();
    await expect.poll(cookies).toEqual([]);
    await addTag(site({ partition: SITE_INCOGNITO_PARTITION }));
    const again = await loaded();
    expect(await run(again, "document.cookie")).not.toContain("hidden=1");
    expect(await run(again, `localStorage.getItem("hidden")`)).toBeNull();
  });

  test("a page reload empties it too, and the sites' session stays", async () => {
    await addTag(site());
    const plain = await loaded();
    await run(plain, `document.cookie = "plain=1; path=/"`);
    await addSecond(site({ src: `${origins.api}/opened`, partition: SITE_INCOGNITO_PARTITION }));
    const hidden = await loaded("/opened");
    await run(hidden, `document.cookie = "hidden=1; path=/"`);
    await l.page.reload();
    await l.page.waitForSelector("#h");
    await expect.poll(cookies).toEqual([]);
    await addTag(site());
    expect(await run(await loaded(), "document.cookie")).toContain("plain=1");
  });

  test("a link stays incognito, on its own event", async () => {
    await takeLinks();
    await l.page.evaluate(() => {
      const host = (window as unknown as { mafoldHost: { on(e: string, cb: (u: string) => void): () => void } }).mafoldHost;
      const w = window as unknown as { __hidden: string[] };
      w.__hidden = [];
      host.on("open-incognito-link", (u) => w.__hidden.push(u));
    });
    await addTag(site({ partition: SITE_INCOGNITO_PARTITION }));
    const id = await loaded();
    await press(id, "#tab");
    await expect.poll(() => l.page.evaluate(() => (window as unknown as { __hidden: string[] }).__hidden)).toEqual([`${origins.api}/opened`]);
    expect(await links()).toEqual([]);
  });

  test("a sign-in popup is in the same session", async () => {
    await takeLinks();
    await addTag(site({ partition: SITE_INCOGNITO_PARTITION }));
    const id = await loaded();
    await run(id, `document.cookie = "hidden=1; path=/"`);
    const opened = l.app.waitForEvent("window");
    await press(id, "#popup");
    await opened;
    await expect.poll(() => run(id, "window.__said")).toBe("signed in");
    const same = await l.app.evaluate(({ session, webContents }, partition) => {
      const w = webContents.getAllWebContents().find((c) => c.getURL().endsWith("/signin"));
      return w ? w.session === session.fromPartition(partition) : null;
    }, SITE_INCOGNITO_PARTITION);
    expect(same).toBe(true);
  });
});

test.describe("who gets a <webview>", () => {
  test("the page, in the sites' own partition", async () => {
    await addTag(site());
    await loaded();
  });

  test("not in the page's own session, nor in none", async () => {
    await addTag(site({ partition: "persist:mafold" }));
    await refused();
    await addTag({ src: `${origins.api}/site` });
    await refused();
  });

  test("not for a file on disk", async () => {
    await addTag(site({ src: "file:///etc/hosts" }));
    await refused();
  });

  test("no frame inside the page can make one", async () => {
    await l.page.evaluate(() => {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.srcdoc = `<webview src="${location.origin}/app" partition="persist:mafold-sites"></webview>`;
      document.body.append(f);
    });
    await refused();
  });
});

test.describe("what a site runs with", () => {
  test("no bridge, no node, whatever the tag asks for", async () => {
    await addTag(
      site({
        nodeintegration: "",
        nodeintegrationinsubframes: "",
        disablewebsecurity: "",
        preload: `file://${process.cwd()}/dist/preload/index.js`,
        webpreferences: "nodeIntegration=yes,contextIsolation=no,sandbox=no,webSecurity=no",
      }),
    );
    const id = await loaded();
    expect(await run(id, "[typeof window.mafoldHost, typeof require, typeof process, typeof Buffer].join()")).toBe("undefined,undefined,undefined,undefined");
    const prefs = await l.app.evaluate(({ webContents }, i) => {
      const p = (webContents.fromId(i) as unknown as { getLastWebPreferences(): Electron.WebPreferences & { preload?: string } }).getLastWebPreferences();
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, webSecurity: p.webSecurity, nodeIntegration: p.nodeIntegration, preload: p.preload ?? null, webviewTag: p.webviewTag };
    }, id);
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false, preload: null, webviewTag: false });
  });

  test("the web origin itself, shown as a site, gets no bridge either", async () => {
    await addTag(site({ src: `${origins.web}/app` }));
    const id = await loaded("/app");
    expect(await run(id, "typeof window.mafoldHost")).toBe("undefined");
  });

  test("its own cookies, apart from the page's; a browser's user agent", async () => {
    await l.page.evaluate(() => (document.cookie = "page=1; path=/"));
    await addTag(site({ src: `${origins.web}/app` }));
    const id = await loaded("/app");
    expect(await run(id, "document.cookie")).toBe("");
    await run(id, `document.cookie = "guest=1; path=/"`);
    expect(await l.page.evaluate(() => document.cookie)).toBe("page=1");
    const ua = await run<string>(id, "navigator.userAgent");
    expect(ua).toContain("Chrome/");
    expect(ua).not.toMatch(/Electron|Mafold/i);
    expect(await l.page.evaluate(() => navigator.userAgent)).toContain("MafoldDesktop/");
  });

  test("clearing site data forgets its cookies and leaves the page's", async () => {
    await l.page.evaluate(() => (document.cookie = "page=1; path=/"));
    await addTag(site());
    const id = await loaded();
    expect(await run(id, "document.cookie")).toBe("site=1");
    const cleared = await l.page.evaluate(() => (window as unknown as { mafoldHost: { clearSiteData(): Promise<boolean> } }).mafoldHost.clearSiteData());
    expect(cleared).toBe(true);
    expect(await run(id, "document.cookie")).toBe("");
    expect(await l.page.evaluate(() => document.cookie)).toBe("page=1");
  });

});

test.describe("what the page can do to a site", () => {
  type Tag = HTMLElement & Record<string, (...a: unknown[]) => Promise<unknown>>;
  const attempt = (method: string, ...args: unknown[]) =>
    l.page.evaluate(
      async ({ method, args }) => {
        const tag = document.querySelector("webview") as Tag;
        try {
          await tag[method](...args);
          return "done";
        } catch (e) {
          return `refused: ${String(e)}`;
        }
      },
      { method, args },
    );

  test("nothing in the page can read a site or act in it", async () => {
    await addTag(site());
    const id = await loaded();
    await run(id, `window.__secret = "signed in"`);
    await expect.poll(() => l.page.evaluate(() => {
      const tag = document.querySelector("webview") as Tag & { getURL(): string };
      try {
        return tag.getURL();
      } catch {
        return "";
      }
    })).toContain("/site");
    for (const method of ["insertCSS", "printToPDF", "capturePage", "send", "sendInputEvent", "insertText"]) {
      expect(await attempt(method, method === "send" ? "x" : {}), method).toContain("refused");
    }
    expect(await attempt("executeJavaScript", "window.__secret")).toContain("refused");
    expect(await attempt("loadURL", "javascript:document.title='got in'")).toContain("refused");
    expect(await run(id, "document.title")).toBe("fixture");
    expect(await attempt("loadURL", "file:///etc/hosts")).toContain("refused");
  });

  test("it can still send a tab somewhere on the web", async () => {
    await addTag(site());
    await loaded();
    await expect.poll(() => attempt("loadURL", `${origins.api}/titled`)).toBe("done");
    await loaded("/titled");
  });
});

test.describe("links in the page", () => {
  test("come to the page while it listens, and go to the system browser once it stops", async () => {
    await takeLinks();
    await l.page.evaluate(() => {
      const a = document.createElement("a");
      a.id = "blank";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.href = "https://example.com/a";
      a.textContent = "a link in a message";
      a.style.cssText = "position:fixed;left:0;top:0;width:200px;height:40px;background:#fff;z-index:9";
      document.body.append(a);
    });
    await l.page.click("#blank");
    await expect.poll(links).toEqual(["https://example.com/a"]);
    expect(l.external().join("\n")).not.toContain("example.com/a");

    await l.page.evaluate(() => (window as unknown as { __stopLinks: () => void }).__stopLinks());
    await l.page.waitForTimeout(1100);
    await l.page.click("#blank");
    await expect.poll(() => l.external().join("\n")).toContain("https://example.com/a");
  });

  test("the file viewer's window.open comes the same way", async () => {
    await takeLinks();
    await l.page.evaluate(() => window.open("https://example.com/b", "_blank", "noopener,noreferrer"));
    await expect.poll(links).toEqual(["https://example.com/b"]);
  });

  test("⌘/Ctrl-click goes to the system browser, even while the page listens", async () => {
    await takeLinks();
    await l.page.evaluate(() => {
      const a = document.createElement("a");
      a.id = "blank";
      a.target = "_blank";
      a.href = "https://example.com/c";
      a.textContent = "a link";
      a.style.cssText = "position:fixed;left:0;top:0;width:200px;height:40px;background:#fff;z-index:9";
      document.body.append(a);
    });
    await l.page.click("#blank", { modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
    await expect.poll(() => l.external().join("\n")).toContain("https://example.com/c");
    expect(await links()).toEqual([]);
  });
});

test.describe("the ways out of a site", () => {
  test("a link it opens comes to the page as a tab", async () => {
    await takeLinks();
    await addTag(site());
    const id = await loaded();
    await press(id, "#tab");
    await expect.poll(links).toEqual([`${origins.api}/opened`]);
    expect(await guests()).toHaveLength(1);
  });

  test("nothing opens unless the person touched it", async () => {
    await takeLinks();
    await addTag(site());
    const id = await loaded();
    await run(id, `window.open("${origins.api}/fountain")`);
    await l.page.waitForTimeout(500);
    expect(await links()).toEqual([]);
    expect(l.external().join("\n")).not.toContain("fountain");
  });

  test("a sign-in popup is a window it can talk to, in the sites' session", async () => {
    await takeLinks();
    await addTag(site());
    const id = await loaded();
    const opened = l.app.waitForEvent("window");
    await press(id, "#popup");
    await opened;
    await expect.poll(() => run(id, "window.__said")).toBe("signed in");
    const popup = await l.app.evaluate(({ session, webContents }, partition) => {
      const w = webContents.getAllWebContents().find((c) => c.getURL().endsWith("/signin"))!;
      return { same: w.session === session.fromPartition(partition), type: w.getType() };
    }, SITE_PARTITION);
    expect(popup).toEqual({ same: true, type: "window" });
    expect(await links()).toEqual([]);
  });

  test("a sign-in that reserves its popup first gets the same window", async () => {
    await takeLinks();
    await addTag(site());
    const id = await loaded();
    const opened = l.app.waitForEvent("window");
    await press(id, "#reserve");
    await opened;
    await expect.poll(() => run(id, "window.__said")).toBe("signed in");
    expect(await links()).toEqual([]);
  });

  test("mailto goes to the system; another program stays shut", async () => {
    await addTag(site());
    const id = await loaded();
    await press(id, "#app");
    await press(id, "#mail");
    await expect.poll(() => l.external().join("\n")).toContain("mailto:someone@example.com");
    expect(l.external().join("\n")).not.toContain("vscode:");
    await expect.poll(() => run(id, "location.pathname")).toBe("/site");
  });

  test("a file lands in Downloads", async () => {
    await addTag(site());
    const id = await loaded();
    await press(id, "#file");
    const { readdirSync } = await import("node:fs");
    await expect.poll(() => readdirSync(l.dirs.downloads)).toEqual(["report.txt"]);
  });
});
