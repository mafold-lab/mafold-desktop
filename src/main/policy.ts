// What the window may do: navigate, open windows, download, ask for
// permissions. Pure functions over URLs and origins, so every rule here is
// unit-tested without Electron (test/policy.spec.ts); `security.ts` wires them
// to the events.

import type { ShellConfig } from "./config";
import { SITE_INCOGNITO_PARTITION, SITE_PARTITION } from "../shared/desktopHost.generated";

type Origins = Pick<ShellConfig, "webOrigin" | "apiOrigin">;

const parse = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** Schemes the system may open for us. Everything else (file:, javascript:,
 *  custom app schemes that would launch another program) is refused. */
const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:", "tel:"]);

export const isExternalUrl = (raw: string): boolean => {
  const u = parse(raw);
  return !!u && EXTERNAL_PROTOCOLS.has(u.protocol);
};

/** A file download from the api: `<api>/download/<id>` answers with
 *  `Content-Disposition: attachment`, and the web links to it as a plain
 *  same-tab `<a href>` (mafold-web lib/session.ts `downloadURL`). */
export const isApiDownload = (raw: string, o: Origins): boolean => {
  const u = parse(raw);
  return !!u && u.origin === o.apiOrigin && u.pathname.startsWith("/download/");
};

export type NavDecision = "allow" | "download" | "tab" | "external" | "deny";

/** A top-level navigation of the main window. `tabs`: the page takes links as
 *  tabs. Then the page being sent off to the web is one more link: a plain `<a
 *  href>`, and the checkout, which has no window of its own to go to here
 *  (`about:blank` isn't a link, below; mafold-web cards/payStore.ts). */
export function decideNavigation(raw: string, o: Origins, tabs = false): NavDecision {
  const u = parse(raw);
  if (!u) return "deny";
  if (u.origin === o.webOrigin) return "allow";
  if (isApiDownload(raw, o)) return "download";
  if (tabs && (u.protocol === "https:" || u.protocol === "http:")) return "tab";
  if (EXTERNAL_PROTOCOLS.has(u.protocol)) return "external";
  return "deny";
}

export type OpenDecision = "tab" | "external" | "child" | "deny";

/** How the opening was asked for (Electron's `details`) and what can take it. */
export interface OpenWay {
  disposition: string;
  features: string;
  frameName: string;
  /** Asked by a site on a tab: a third party, whatever referrer it sent. */
  site: boolean;
  /** The page takes links as tabs: it listens to `open-link`. */
  tabs: boolean;
}

const NOT_TAKEN: OpenWay = { disposition: "foreground-tab", features: "", frameName: "", site: false, tabs: false };

/**
 * A `window.open` / `target=_blank` from anywhere in the main window.
 *
 * A link goes to a tab when the page takes them: a ⌘/Ctrl-click
 * (`background-tab`) or a shift-click (`new-window`, no size) is the way to the
 * system browser.
 *
 * The opener is known only by the referrer it sent:
 *  - our own page (or no referrer: HTML cards are `no-referrer` srcdoc frames)
 *    ⇒ a tab or the system browser, whatever size it asks for. The page's own
 *    OAuth no longer opens popups here (`oauth-external`), so nothing of ours
 *    needs a window it can script.
 *  - a third-party page (a webview mini-app, `allow-popups-to-escape-sandbox`;
 *    a site on a tab) ⇒ a plain child window for a popup with a size or a name:
 *    a sign-in talks back through `window.opener`, which a tab or the system
 *    browser would cut. The child never gets the bridge: the preload only
 *    exposes it on the web origin, and the main process only answers the main
 *    window's main frame.
 *  - a site opening a blank window, to point it somewhere once it knows where
 *    (`window.open("")`: Firebase's sign-in, PayPal's button) ⇒ that child
 *    window too. Refused, the sign-in just wouldn't start.
 */
export function decideWindowOpen(raw: string, referrer: string, o: Origins, way: OpenWay = NOT_TAKEN): OpenDecision {
  if (raw === "about:blank" && way.site) return "child";
  const u = parse(raw);
  if (!u || !EXTERNAL_PROTOCOLS.has(u.protocol)) return "deny";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "external";
  const from = parse(referrer);
  const thirdParty = way.site || (!!from && (from.protocol === "https:" || from.protocol === "http:") && from.origin !== o.webOrigin);
  const popup = (way.disposition === "new-window" && !!way.features) || !!way.frameName;
  if (thirdParty && (popup || (!way.tabs && !way.site))) return "child";
  return way.tabs && (popup || way.disposition === "foreground-tab") ? "tab" : "external";
}

/** A site on a tab going somewhere by itself: the web, and mailto/tel to the
 *  system. Nothing else: a site can't launch another program. */
export function decideSiteNavigation(raw: string): "allow" | "external" | "deny" {
  const u = parse(raw);
  if (!u) return "deny";
  if (u.protocol === "https:" || u.protocol === "http:" || raw === "about:blank") return "allow";
  return EXTERNAL_PROTOCOLS.has(u.protocol) ? "external" : "deny";
}

/** A `<webview>` may stand in one place: the page, on the web origin, showing
 *  a site from the web, in the sites' own partition (they never share the
 *  Mafold sign-in). `embedder`: the url of the top-level document asking. */
export function mayAttachSite(embedder: string, params: { partition?: string; src?: string }, o: Origins): boolean {
  if (parse(embedder)?.origin !== o.webOrigin) return false;
  if (params.partition !== SITE_PARTITION && params.partition !== SITE_INCOGNITO_PARTITION) return false;
  const src = parse(params.src ?? "");
  return src?.protocol === "https:" || src?.protocol === "http:";
}

/** What a site's page runs with, whatever the tag asked for: nothing of the
 *  shell's. Plugins for the built-in PDF viewer. */
export function hardenSite(prefs: Record<string, unknown>): void {
  for (const k of ["preload", "preloadURL", "additionalArguments", "enableBlinkFeatures", "disableBlinkFeatures"]) delete prefs[k];
  Object.assign(prefs, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    plugins: true,
    disablePopups: false,
  });
}

/** The permissions the web origin's top frame may have, and the few any frame may. */
const MAIN_FRAME = new Set(["notifications", "media", "clipboard-sanitized-write", "fullscreen", "openExternal"]);
const ANY_FRAME = new Set(["clipboard-sanitized-write", "fullscreen"]);

export interface PermissionAsk {
  permission: string;
  requestingOrigin: string;
  isMainFrame: boolean;
  /** For `media`: what is being asked for. Only audio is ever granted (dictation). */
  mediaTypes?: readonly string[];
  /** For `openExternal`: where to. */
  externalURL?: string;
}

export function permissionAllowed(ask: PermissionAsk, o: Origins): boolean {
  const ours = parse(ask.requestingOrigin)?.origin === o.webOrigin;
  if (ours && ask.isMainFrame && MAIN_FRAME.has(ask.permission)) {
    if (ask.permission === "media") return !!ask.mediaTypes?.length && ask.mediaTypes.every((t) => t === "audio");
    if (ask.permission === "openExternal") return !!ask.externalURL && isExternalUrl(ask.externalURL);
    return true;
  }
  return ANY_FRAME.has(ask.permission);
}

/** What a site on a tab may have without asking, and what it must ask the
 *  person for. Nothing else: no notifications, no devices, no other programs. */
const SITE_FREE = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock", "mediaKeySystem"]);
const SITE_ASKED = new Set(["media", "geolocation", "clipboard-read"]);

export const sitePermission = (permission: string): "allow" | "ask" | "deny" =>
  SITE_FREE.has(permission) ? "allow" : SITE_ASKED.has(permission) ? "ask" : "deny";

/** What the person is being asked about, one word for each thing: a grant is
 *  kept under the word, a question ends in the words (`siteQuestion`). */
export function siteAsks(permission: string, mediaTypes?: readonly string[]): string[] {
  if (permission === "geolocation") return ["location"];
  if (permission === "clipboard-read") return ["clipboard"];
  if (permission !== "media") return [];
  return (mediaTypes ?? []).flatMap((t) => (t === "video" ? ["camera"] : t === "audio" ? ["microphone"] : []));
}

/** The key of the question about `asks`: the shell's own words, in the pack. */
export const siteQuestion = (asks: readonly string[]): string =>
  `desktop.site.ask.${[...asks].sort().map((a, i) => (i ? `And${a[0].toUpperCase()}${a.slice(1)}` : a)).join("")}`;

/** Keys pressed in a site never reach the page. These are the ones a tab owes
 *  the person: all but `back` and `forward` go to the page as commands. */
export type SiteKey = "close-tab" | "focus-address" | "new-incognito" | "back" | "forward";

export function siteShortcut(
  input: { type: string; key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean },
  mac: boolean,
): SiteKey | null {
  if (input.type !== "keyDown") return null;
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  const key = input.key.toLowerCase();
  if (mod && !input.alt && input.shift && key === "n") return "new-incognito";
  if (mod && !input.alt && !input.shift) {
    if (key === "w") return "close-tab";
    if (key === "l") return "focus-address";
    if (mac && key === "[") return "back";
    if (mac && key === "]") return "forward";
  }
  const altOnly = input.alt && !input.control && !input.meta && !input.shift;
  if (!mac && altOnly && key === "arrowleft") return "back";
  if (!mac && altOnly && key === "arrowright") return "forward";
  return null;
}

/** Chromium's own user agent, without the `Electron/…` and app-name tokens: what
 *  a site on a tab sees. Some sign-ins refuse a browser that says it is an app. */
export const siteUserAgent = (chromiumUa: string): string =>
  chromiumUa
    .replace(/\s+Electron\/\S+/g, "")
    .replace(/\s+(MafoldDesktop|Mafold|mafold-desktop)\/\S+/gi, "")
    .trim();

/**
 * The user agent the shell presents: Chromium's own, minus the `Electron/…`
 * and app-name tokens, plus `MafoldDesktop/<version>`. Sites (and Cloudflare in
 * front of ours) see the browser engine it really is; the api names the session
 * "Mafold Desktop on macOS" from the last token (store.rs `name_from_ua`).
 */
export function shellUserAgent(chromiumUa: string, version: string): string {
  return `${siteUserAgent(chromiumUa)} MafoldDesktop/${version}`;
}

/** The page's own origin, or null for anything that is not a URL we can name. */
export const originOf = (raw: string): string | null => parse(raw)?.origin ?? null;
