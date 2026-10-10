// Two local origins standing in for production:
//   web  — the page the window shows (`/app`), with a sandboxed srcdoc card and
//          a cross-origin frame inside it, the way the real chat embeds them;
//   api  — a different origin: file downloads, the cross-origin frame, and a
//          "third-party" page for popups.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron, type ElectronApplication, type Page } from "@playwright/test";

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
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        html(`
<h1 id="h">fixture app</h1>
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
  if (window.mafoldHost) {
    mafoldHost.on("navigate", (h) => window.__events.push(["navigate", h]));
    mafoldHost.on("command", (c) => window.__events.push(["command", c]));
    mafoldHost.on("daemon", (s) => window.__daemon.push(s));
    if (mafoldHost.caps.includes("notify-settings")) mafoldHost.on("notify-permission", (p) => window.__events.push(["notify-permission", p]));
  }
</script>`),
      );
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

export async function launch(web: string, api: string, extraEnv: Record<string, string> = {}): Promise<Launched> {
  const root = mkdtempSync(join(tmpdir(), "mafold-desktop-e2e-"));
  const dirs = {
    root,
    userData: join(root, "user"),
    downloads: mkdtempSync(join(root, "dl-")),
    externalLog: join(root, "external.log"),
    // The daemon manager's world: a temp mafold home, the fake cli, its state.
    mafoldHome: join(root, "mafold-home"),
    fakeState: join(root, "fake-mafold.json"),
  };
  const app = await _electron.launch({
    args: [join(__dirname, ".."), ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
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
  const page = await app.firstWindow();
  return {
    app,
    page,
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
