// Everything the page sends over the bridge is untrusted input — the page runs
// third-party card code in its own realm (mafold-web cards/loader.ts). Each
// payload is reduced to exactly the shape the shell uses, with every string
// clipped, before anything native sees it. Pure, so test/validate.spec.ts
// covers it without Electron.

import { HOST_COMMANDS, WINDOW_ACTIONS, type Appearance, type HostEventName, type HostNotification, type UnreadSummary, type WindowAction } from "../shared/desktopHost.generated";
import { clip } from "./limits";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOP = 8;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), 1_000_000)) : 0);

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
  return { convId: o.convId, msgId, title, body: clip(o.body, 400), silent: o.silent === true };
}

export const readAppearance = (v: unknown): Appearance | null => (v === "light" || v === "dark" || v === "system" ? v : null);

export const readEventName = (v: unknown): HostEventName | null =>
  v === "navigate" || v === "command" || v === "resume" || v === "daemon" || v === "window" ? v : null;

export const readWindowAction = (v: unknown): WindowAction | null =>
  typeof v === "string" && (WINDOW_ACTIONS as readonly string[]).includes(v) ? (v as WindowAction) : null;

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
