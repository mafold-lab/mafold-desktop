// Two local origins standing in for production:
//   web  — the page the window shows (`/app`), with a sandboxed srcdoc card and
//          a cross-origin frame inside it, the way the real chat embeds them;
//   api  — a different origin: file downloads, the cross-origin frame, and a
//          "third-party" page for popups.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron, type ElectronApplication, type Frame, type Page } from "@playwright/test";

export interface Origins {
  web: string;
  api: string;
  close(): Promise<void>;
}

const listen = (s: Server) =>
  new Promise<string>((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;

export async function startOrigins(): Promise<Origins> {
  let apiOrigin = "";
  const web = createServer((req, res) => {
    // A do-nothing service worker, for the Web Push probe (shell.spec.ts).
    if (req.url === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("self.addEventListener('push', () => {});");
      return;
    }
    if (req.url?.startsWith("/app")) {
      const page = html(`
<h1 id="h">fixture app</h1>
<!-- The shape of every file's ↓ in the web app (the media viewer's included):
     a plain link to an api download, no target. -->
<a id="dl" href="${apiOrigin}/download/report.txt">download</a>
<a id="ext" href="${apiOrigin}/elsewhere">elsewhere</a>
<iframe id="card" sandbox="allow-scripts" srcdoc="<script>let r={};try{r.parent=typeof parent.mafoldHost}catch(e){r.parent='blocked'};r.self=typeof window.mafoldHost;parent.postMessage({card:r},'*')</script>"></iframe>
<iframe id="xo" src="${apiOrigin}/frame.html"></iframe>
<script>
  window.__events = [];
  window.__frames = {};
  addEventListener("message", (e) => {
    if (e.data && e.data.card) window.__frames.card = e.data.card;
    if (e.data && e.data.xo) window.__frames.xo = e.data.xo;
  });
  window.__daemon = [];
  window.__update = [];
  // \`?quiet\`: a page that listens to nothing until told to.
  window.__listen = () => {
    mafoldHost.on("navigate", (h) => window.__events.push(["navigate", h]));
    mafoldHost.on("command", (c) => window.__events.push(["command", c]));
    mafoldHost.on("daemon", (s) => window.__daemon.push(s));
    if (mafoldHost.caps.includes("notify-settings")) mafoldHost.on("notify-permission", (p) => window.__events.push(["notify-permission", p]));
    if (mafoldHost.caps.includes("update")) mafoldHost.on("update", (u) => window.__update.push(u));
  };
  if (window.mafoldHost && !location.search.includes("quiet")) window.__listen();
</script>`);
      // `?slow`: a page that takes a while to arrive — 1.5 s (document.spec.ts),
      // or `?slow=<ms>` (cover.spec.ts: long enough to look at the cover).
      const slow = /[?&]slow(?:=(\d+))?/.exec(req.url);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page);
      }, slow ? Number(slow[1] ?? 1500) : 0);
      return;
    }
    res.writeHead(404).end();
  });
  const api = createServer((req, res) => {
    if (req.url === "/download/report.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' });
      res.end("hello from the api");
      return;
    }
    if (req.url === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html(`<script>parent.postMessage({ xo: typeof window.mafoldHost }, "*")</script>`));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html(`<p id="third">third party</p>`));
  });
  const webOrigin = await listen(web);
  apiOrigin = await listen(api);
  return {
    web: webOrigin,
    api: apiOrigin,
    close: async () => {
      await new Promise((r) => web.close(r));
      await new Promise((r) => api.close(r));
    },
  };
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  dirs: { root: string; userData: string; downloads: string; externalLog: string; mafoldHome: string; fakeState: string };
  external(): string[];
}

/** A data directory that already holds `files` (name → contents) — what a
 *  shell left behind before the one about to start. Pass it on as
 *  `MAFOLD_DESKTOP_USER_DATA`; launch's own directory does not exist until the
 *  shell creates it. */
export function profile(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "mafold-desktop-e2e-profile-")), "user");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** 主窗口的那张页面 —— 不是开窗时盖在它上面的加载画面(src/main/cover.ts):
 *  那层也是一个 web contents,Playwright 把它也当一个 page 列出来,还可能排在
 *  前面(`firstWindow()` 会拿到它)。那层的文档是 data: URL,撤掉时就关了;主窗口
 *  的是网页源上的,或者离线页(之前可能先是一张出错页)。还没提交第一份文档时两边
 *  都是空白页,所以等到有一张提交了不是 data: 的文档。 */
export async function mainPage(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const isMain = (p: Page) => {
    const u = p.url();
    return u !== "" && u !== "about:blank" && !u.startsWith("data:");
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = app.windows().find(isMain);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no main window page after ${timeoutMs} ms: ${app.windows().map((p) => p.url().slice(0, 40)).join(", ")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 页面里那个跨源 iframe(api 源的 frame.html)。它在自己的渲染进程里,进程起来、
 *  文档提交了才在 frames() 里认得出是 api 源的 —— `#h` 出来时不一定好了:等它。
 *  Windows 的 CI 上这是老毛病(10-24 第一趟就红过 shell.spec 第三方弹窗那条,
 *  scripts/ci/public-desktop/desktop-pr-tests.yml 记着),开窗时多起了盖层那一个
 *  渲染进程以后更常见。 */
export async function apiFrame(page: Page, api: string, timeoutMs = 10_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = page.frames().find((f) => f.url().startsWith(api));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no ${api} frame after ${timeoutMs} ms: ${page.frames().map((f) => f.url().slice(0, 40)).join(", ")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 只把壳起起来,不等页面(cover.spec.ts 要在页面到之前看窗口);下面的
 *  `launch` 再等主窗口那张页面。 */
export async function start(web: string, api: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<Omit<Launched, "page">> {
  const root = mkdtempSync(join(tmpdir(), "mafold-desktop-e2e-"));
  const dirs = {
    root,
    // The one the shell is pointed at below: its own, or one handed over.
    userData: extraEnv.MAFOLD_DESKTOP_USER_DATA ?? join(root, "user"),
    downloads: mkdtempSync(join(root, "dl-")),
    externalLog: join(root, "external.log"),
    // The daemon manager's world: a temp mafold home, the fake cli, its state.
    mafoldHome: join(root, "mafold-home"),
    fakeState: join(root, "fake-mafold.json"),
  };
  const app = await _electron.launch({
    args: [join(__dirname, ".."), ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...extraArgs],
    // The page's light / dark is the shell's to decide (nativeTheme, the
    // appearance it keeps: ground.spec.ts). Left to its default, Playwright
    // pins every page it drives to light.
    colorScheme: null,
    env: {
      ...process.env,
      MAFOLD_DESKTOP_TEST: "1",
      MAFOLD_DESKTOP_WEB: web,
      MAFOLD_DESKTOP_API: api,
      MAFOLD_DESKTOP_USER_DATA: dirs.userData,
      MAFOLD_DESKTOP_DOWNLOADS: dirs.downloads,
      MAFOLD_DESKTOP_EXTERNAL_LOG: dirs.externalLog,
      MAFOLD_DESKTOP_MAFOLD_HOME: dirs.mafoldHome,
      MAFOLD_DESKTOP_CLI: join(__dirname, "fake-mafold.cjs"),
      MAFOLD_FAKE_STATE: dirs.fakeState,
      MAFOLD_DESKTOP_TEST_CONFIRM: "yes",
      ...extraEnv,
    },
  });
  return {
    app,
    dirs,
    external: () => {
      try {
        return readFileSync(dirs.externalLog, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

export async function launch(web: string, api: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<Launched> {
  const s = await start(web, api, extraEnv, extraArgs);
  try {
    return { ...s, page: await mainPage(s.app) };
  } catch (e) {
    await s.app.close();
    throw e;
  }
}
