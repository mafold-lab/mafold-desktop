// Everything the page sends over the bridge is untrusted input — the page runs
// third-party card code in its own realm (mafold-web cards/loader.ts). Each
// payload is reduced to exactly the shape the shell uses, with every string
// clipped, before anything native sees it. Pure, so test/validate.spec.ts
// covers it without Electron.

import { ALL_CHANNEL, HOST_COMMANDS, SITE_AGENT_KEYS, WINDOW_ACTIONS, WINDOW_LAYOUTS, type Appearance, type HostEventName, type HostNotification, type SiteAgentAct, type SiteAgentKey, type UnreadSummary, type WindowAction, type WindowLayout } from "../shared/desktopHost.generated";
import { clip } from "./limits";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOP = 8;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), 1_000_000)) : 0);

export const readConvId = (v: unknown): string | null => (typeof v === "string" && ID_RE.test(v) ? v : null);

/** `openChatWindow`'s channel: undefined is the whole conversation. */
export const readChatChannel = (v: unknown): string | undefined => (v === ALL_CHANNEL ? ALL_CHANNEL : (readConvId(v) ?? undefined));

export function readUnread(v: unknown): UnreadSummary | null {
  const o = obj(v);
  if (!o) return null;
  const top = Array.isArray(o.top) ? o.top : [];
  return {
    total: count(o.total),
    top: top
      .map(obj)
      .filter((e): e is Record<string, unknown> => !!e && typeof e.convId === "string" && ID_RE.test(e.convId))
      .slice(0, MAX_TOP)
      .map((e) => ({
        convId: e.convId as string,
        title: clip(e.title, 80) || "Mafold",
        preview: clip(e.preview, 120).replace(/\s+/g, " "),
        count: count(e.count),
      })),
  };
}

/** Two (already validated) summaries that would draw the same tray and badge. */
export const sameUnread = (a: UnreadSummary, b: UnreadSummary): boolean =>
  a.total === b.total &&
  a.top.length === b.top.length &&
  a.top.every((e, i) => {
    const f = b.top[i];
    return e.convId === f.convId && e.title === f.title && e.preview === f.preview && e.count === f.count;
  });

export function readNotification(v: unknown): HostNotification | null {
  const o = obj(v);
  if (!o || typeof o.convId !== "string" || !ID_RE.test(o.convId)) return null;
  const msgId = typeof o.msgId === "string" && ID_RE.test(o.msgId) ? o.msgId : undefined;
  const title = clip(o.title, 120);
  if (!title) return null;
  const channelId = readConvId(o.channelId) ?? undefined;
  return { convId: o.convId, msgId, channelId, title, body: clip(o.body, 400), silent: o.silent === true };
}

export const readAppearance = (v: unknown): Appearance | null => (v === "light" || v === "dark" || v === "system" ? v : null);

export const readEventName = (v: unknown): HostEventName | null =>
  v === "navigate" || v === "share" || v === "command" || v === "resume" || v === "daemon" || v === "window" || v === "notify-permission" || v === "update" || v === "logs" || v === "open-link" || v === "open-incognito-link" || v === "site-agent" ? v : null;

export const readWindowAction = (v: unknown): WindowAction | null =>
  typeof v === "string" && (WINDOW_ACTIONS as readonly string[]).includes(v) ? (v as WindowAction) : null;

export const readWindowLayout = (v: unknown): WindowLayout | null =>
  typeof v === "string" && (WINDOW_LAYOUTS as readonly string[]).includes(v) ? (v as WindowLayout) : null;

export const isHostCommand = (v: unknown): boolean => typeof v === "string" && (HOST_COMMANDS as readonly string[]).includes(v);

/** An authorization URL must be https — a provider's consent page, nothing local. */
export function readAuthorizeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 8192) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

export function readLocale(lang: unknown, strings: unknown): { lang: string; strings: Record<string, unknown> } | null {
  if (typeof lang !== "string" || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,3}$/.test(lang)) return null;
  return { lang, strings: obj(strings) ?? {} };
}

// ── site-agent ──────────────────────────────────────────────────────────────

/** A `<webview>`'s contents id. Which contents it is, and whether it is a site
 *  on the page, is the shell's to check (siteAgent.ts). */
export const readTabId = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/** A grant id, as the shell made it (`crypto.randomUUID`). */
export const readGrantId = (v: unknown): string | null => (typeof v === "string" && ID_RE.test(v) ? v : null);

/** The agent the dialog names: a Mafold username (`owner:bot` for a bot). */
export const readAgentName = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(v) ? v : null);

/** A ref from a look (`e12`), or the words on a thing: one line, clipped. */
export const readAgentRef = (v: unknown): string | null => {
  const s = clip(v, 120).replace(/\s+/g, " ").trim();
  return s ? s : null;
};

/** The most a page may type in one act. */
export const MAX_AGENT_TEXT = 2000;
const MAX_POINT = 100_000;

export function readSiteAct(v: unknown): SiteAgentAct | null {
  const o = obj(v);
  if (!o) return null;
  const keys = Object.keys(o);
  if (keys.length !== 1) return null;
  if ("click" in o) {
    const p = obj(o.click);
    const x = p?.x, y = p?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x > MAX_POINT || y > MAX_POINT) return null;
    return { click: { x: Math.round(x), y: Math.round(y) } };
  }
  if ("type" in o) return typeof o.type === "string" && o.type.length > 0 && o.type.length <= MAX_AGENT_TEXT ? { type: o.type } : null;
  if ("key" in o) return typeof o.key === "string" && (SITE_AGENT_KEYS as readonly string[]).includes(o.key) ? { key: o.key as SiteAgentKey } : null;
  if ("scroll" in o) return typeof o.scroll === "number" && Number.isFinite(o.scroll) ? { scroll: Math.max(-5000, Math.min(5000, Math.round(o.scroll))) } : null;
  if ("goto" in o) {
    if (typeof o.goto !== "string" || o.goto.length > 2048) return null;
    try {
      const u = new URL(o.goto);
      return u.protocol === "https:" || u.protocol === "http:" ? { goto: u.toString() } : null;
    } catch {
      return null;
    }
  }
  return null;
}
