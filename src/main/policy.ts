// What the window may do: navigate, open windows, download, ask for
// permissions. Pure functions over URLs and origins, so every rule here is
// unit-tested without Electron (test/policy.spec.ts); `security.ts` wires them
// to the events.

import type { ShellConfig } from "./config";

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

export type NavDecision = "allow" | "download" | "external" | "deny";

/** A top-level navigation of the main window. */
export function decideNavigation(raw: string, o: Origins): NavDecision {
  const u = parse(raw);
  if (!u) return "deny";
  if (u.origin === o.webOrigin) return "allow";
  if (isApiDownload(raw, o)) return "download";
  if (EXTERNAL_PROTOCOLS.has(u.protocol)) return "external";
  return "deny";
}

export type OpenDecision = "external" | "child" | "deny";

/**
 * A `window.open` / `target=_blank` from anywhere in the main window.
 *
 * The opener is known only by the referrer it sent:
 *  - our own page (or no referrer: HTML cards are `no-referrer` srcdoc frames)
 *    ⇒ the system browser. The page's own OAuth no longer opens popups here
 *    (`oauth-external`), so nothing of ours needs a window it can script.
 *  - a third-party page (a webview mini-app, `allow-popups-to-escape-sandbox`)
 *    ⇒ a plain child window. Its own sign-in popups talk back through
 *    `window.opener`, which the system browser would cut. The child never gets
 *    the bridge: the preload only exposes it on the web origin, and the main
 *    process only answers the main window's main frame.
 */
export function decideWindowOpen(raw: string, referrer: string, o: Origins): OpenDecision {
  const u = parse(raw);
  if (!u || !EXTERNAL_PROTOCOLS.has(u.protocol)) return "deny";
  const from = parse(referrer);
  const thirdParty = !!from && (from.protocol === "https:" || from.protocol === "http:") && from.origin !== o.webOrigin;
  if (thirdParty && (u.protocol === "https:" || u.protocol === "http:")) return "child";
  return "external";
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

/**
 * The user agent the shell presents: Chromium's own, minus the `Electron/…`
 * and app-name tokens, plus `MafoldDesktop/<version>`. Sites (and Cloudflare in
 * front of ours) see the browser engine it really is; the api names the session
 * "Mafold Desktop on macOS" from the last token (store.rs `name_from_ua`).
 */
export function shellUserAgent(chromiumUa: string, version: string): string {
  const base = chromiumUa
    .replace(/\s+Electron\/\S+/g, "")
    .replace(/\s+(MafoldDesktop|Mafold|mafold-desktop)\/\S+/gi, "")
    .trim();
  return `${base} MafoldDesktop/${version}`;
}

/** The page's own origin, or null for anything that is not a URL we can name. */
export const originOf = (raw: string): string | null => parse(raw)?.origin ?? null;
