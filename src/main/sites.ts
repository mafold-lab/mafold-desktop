// The sites on the app page's tabs: `<webview>`s of the page (mafold-web
// components/SiteView.tsx), in a session of their own. The page draws them and
// the toolbar around them; what they may do is decided here, for the guests
// themselves, so nothing a site runs can talk its way past it. Who gets a
// `<webview>` at all, and what opens a tab, is security.ts.

import { app, dialog, session as electronSession, type Session, type WebContents } from "electron";
import { join } from "node:path";

import { log, redact } from "./log";
import { decideSiteNavigation, originOf, siteAsks, sitePermission, siteQuestion, siteShortcut, siteUserAgent } from "./policy";
import { guardDownloads, guardPasskeyPicker } from "./security";
import type { Shell } from "./shell";
import { SiteGrants } from "./siteGrants";
import { attachContextMenu } from "./contextMenu";
import { SITE_PARTITION } from "../shared/desktopHost.generated";

let grants: SiteGrants | null = null;
const asking = new Map<string, Promise<boolean>>();

/** Every site contents the app creates, and the session they share. */
export function guardSites(shell: Shell): void {
  guardSiteSession(shell);
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() === "webview") guardSite(contents, shell);
  });
}

/** What the tag's methods would let the page do to a site, past showing it.
 *  They run here, on this object (Electron's guest-view manager), and the app
 *  uses none of them. The page isn't the only code in the page: a card runs in
 *  its realm (mafold-web cards/loader.ts), and a site can be someone's signed-in
 *  account. So nothing in the page can read a site, or act in it. */
const SEALED = [
  "executeJavaScript",
  "executeJavaScriptInIsolatedWorld",
  "insertCSS",
  "insertText",
  "capturePage",
  "printToPDF",
  "print",
  "send",
  "sendToFrame",
  "sendInputEvent",
  "openDevTools",
  "inspectElement",
  "inspectSharedWorker",
  "inspectServiceWorker",
  "findInPage",
  "setUserAgent",
] as const;

function seal(contents: WebContents): void {
  const refused = () => Promise.reject(new Error("not for a site"));
  const own = contents as unknown as Record<string, unknown>;
  for (const method of SEALED) own[method] = refused;
  // The page goes on choosing where a tab goes: the web, by the same rule as
  // the site itself. `javascript:` here would be `executeJavaScript`.
  const load = contents.loadURL.bind(contents);
  contents.loadURL = (url, options) => (decideSiteNavigation(url) === "allow" ? load(url, options) : refused());
}

function guardSite(contents: WebContents, shell: Shell): void {
  seal(contents);
  const go = (e: Electron.Event, url: string) => {
    const decision = decideSiteNavigation(url);
    if (decision === "allow") return;
    e.preventDefault();
    if (decision === "external") shell.openExternal(url, "site");
    else log("refused site navigation:", redact(url));
  };
  contents.on("will-navigate", (e) => go(e, e.url));
  contents.on("will-redirect", (e) => {
    if (e.isMainFrame) go(e, e.url);
  });

  // In every frame of the site, cross-origin ones included: both of these come
  // before the frame gets the event.
  contents.on("before-mouse-event", (_e, mouse) => {
    if (mouse.type === "mouseDown") shell.siteActs.saw(contents, Date.now());
  });
  contents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown") shell.siteActs.saw(contents, Date.now());
    const key = siteShortcut(input, process.platform === "darwin");
    if (!key) return;
    e.preventDefault();
    if (key === "close-tab" || key === "focus-address") shell.emit("command", key);
    else if (key === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (key === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  });

  attachContextMenu(contents, shell);
}

function guardSiteSession(shell: Shell): Session {
  const ses = electronSession.fromPartition(SITE_PARTITION);
  ses.setUserAgent(siteUserAgent(ses.getUserAgent()));
  const saved = new SiteGrants(join(app.getPath("userData"), "site-permissions.json"));
  grants = saved;

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details as { requestingUrl?: string; mediaTypes?: string[] };
    const decision = sitePermission(permission);
    if (decision !== "ask") return callback(decision === "allow");
    const origin = originOf(d.requestingUrl ?? wc.getURL());
    const asks = siteAsks(permission, d.mediaTypes);
    if (!origin || !asks.length) return callback(false);
    void ask(shell, saved, origin, asks).then(callback);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const decision = sitePermission(permission);
    if (decision !== "ask") return decision === "allow";
    const origin = originOf(requestingOrigin);
    const type = (details as { mediaType?: string }).mediaType;
    const asks = siteAsks(permission, type ? [type] : undefined);
    return !!origin && asks.length > 0 && asks.every((a) => saved.get(origin, a) === true);
  });

  guardPasskeyPicker(ses, shell);
  guardDownloads(ses, shell);
  return ses;
}

/** What the person has said about `asks` on this site, or what they say now:
 *  one question per site and thing, in the shell's own words. */
async function ask(shell: Shell, saved: SiteGrants, origin: string, asks: string[]): Promise<boolean> {
  const known = asks.map((a) => saved.get(origin, a));
  if (known.includes(false)) return false;
  const open = asks.filter((_a, i) => known[i] === undefined);
  if (!open.length) return true;
  const key = `${origin} ${open.join("+")}`;
  const held = asking.get(key);
  if (held) return held;
  const question = (async () => {
    const f = (k: string, vars?: Record<string, string>) => shell.strings.frozen(k, vars);
    const options = {
      type: "question" as const,
      message: f(siteQuestion(open), { site: new URL(origin).host }),
      buttons: [f("desktop.site.allow"), f("desktop.site.block")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const win = shell.window;
    const r = await (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    const allowed = r.response === 0;
    for (const a of open) saved.set(origin, a, allowed);
    return allowed;
  })()
    .catch((err: unknown) => {
      log("site permission question failed:", String(err));
      return false;
    })
    .finally(() => asking.delete(key));
  asking.set(key, question);
  return question;
}

/** Settings ▸ forget what sites stored here, and what they were allowed. */
export async function clearSiteData(): Promise<boolean> {
  const ses = electronSession.fromPartition(SITE_PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  grants?.clear();
  return true;
}

