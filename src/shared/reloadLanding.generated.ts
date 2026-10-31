// GENERATED from client-shared/reloadLanding.ts — DO NOT EDIT.
// ── Where a reload lands ─────────────────────────────────────────────────────
// ONE copy for every TypeScript client: mafold-rn imports this file directly,
// mafold-web compiles a generated copy at `src/app/app/lib/reloadLanding.generated.ts`
// and mafold-desktop one at `src/shared/reloadLanding.generated.ts` (each
// one's scripts/sync-shared.mjs). Edit HERE.
//
// Three things reload the app under a person: the web page taking a newer
// build (mafold-web lib/freshBuild.ts — a page switch, or the update pill),
// the desktop shell restarting into a new version, the phone swapping its JS
// bundle. Each must arrive where the person was: the conversation, and the
// pane over it. The landing is written the moment before the reload and read
// once by the load that follows — so it is one format, with one rule for
// "is this landing this load's" (`landingFresh`; the keeper names how long),
// whatever storage keeps it (the web page's session storage, or its local
// storage across the desktop's restart; the phone's MMKV).
//
// The desktop shell keeps one part itself, in its data directory
// (mafold-desktop src/main/relaunch.ts): the hash the page showed — the
// conversation, the garden, the moments, read with `landingFromHash` like the
// web app reads it, kept as `landingHash` writes it — for
// `RESTART_LANDING_TTL`, since an install comes between. A pane the hash does
// not hold (the wallet, Settings) is the page's to keep before it asks for the
// restart, for that same life.
//
// Not kept, on any client: overlays, scroll positions, a thread panel.
//
// No imports, on purpose: the web copy is a standalone generated file, and
// lib/freshBuild.ts — loaded with the root error boundary on every page —
// compiles it in.

export type LandingPane = "garden" | "moments" | "wallet" | "settings";

/** Where a reload arrives: a pane, and the conversation under it — or just a
 *  conversation (`null` everywhere: the chat list). */
export interface Landing {
  conv?: string | null;
  /** A message to land on (the garden's way back to a conversation). */
  msg?: string | null;
  /** The conversation's channel, where the client does not remember it itself. */
  channel?: string | null;
  pane?: LandingPane | null;
  /** Settings' page. */
  section?: string | null;
  /** Who it was written for, where the client knows: a landing is not another account's. */
  account?: string | null;
}

/** A landing as kept: with when it was written. */
export interface KeptLanding extends Landing {
  at: number;
}

/** How long a kept landing is the next load's. A reload writes it the moment
 *  before it goes; one older than this belongs to some earlier load. */
export const LANDING_TTL = 60_000;

/** The longer road: a restart into a new version installs it first. How long
 *  the desktop shell keeps the hash it comes back to (mafold-desktop
 *  relaunch.ts), and how long the page's own landing for that restart is the
 *  next load's — one life for both halves of the one landing. */
export const RESTART_LANDING_TTL = 10 * 60_000;

/** Whether a landing kept at `at` is still the next load's at `now`: younger
 *  than `ttl` — a reload's minute, unless the keeper's road is longer
 *  (`RESTART_LANDING_TTL`). A clock that went back since does not make it
 *  older: it was written the moment before. No time at all is not fresh.
 *  (Not a type guard: a number too old is false as well — a caller that uses
 *  `at` checks it is a number itself.) */
export function landingFresh(at: unknown, now: number, ttl: number = LANDING_TTL): boolean {
  return typeof at === "number" && now - at < ttl;
}

/** `sessionStorage`, `localStorage`, the phone's MMKV shim. */
export interface LandingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Keep `to` for the next load. Throws whatever the storage throws: the
 *  caller decides what a reload is worth without it. */
export function keepLanding(store: LandingStorage, key: string, to: Landing, at: number): void {
  store.setItem(key, JSON.stringify({ ...to, at }));
}

const PANES: readonly LandingPane[] = ["garden", "moments", "wallet", "settings"];
const TEXT_FIELDS = ["conv", "msg", "channel", "section", "account"] as const;

/**
 * The landing kept for this load — once (it is gone after, whatever it held),
 * and only if it is this load's: younger than `ttl`, and written for this
 * `account` when both sides know one. A field of the wrong shape is dropped,
 * a landing of the wrong shape is none. Never throws.
 */
export function takeLanding(
  store: LandingStorage,
  key: string,
  now: number,
  opts: { account?: string | null; ttl?: number } = {},
): KeptLanding | null {
  let v: unknown;
  try {
    const raw = store.getItem(key);
    if (raw == null) return null;
    store.removeItem(key);
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const at = o.at;
  if (typeof at !== "number" || !landingFresh(at, now, opts.ttl)) return null;
  const out: KeptLanding = { at };
  for (const f of TEXT_FIELDS) {
    const x = o[f];
    if (typeof x === "string" || x === null) out[f] = x;
  }
  if (o.pane === null || PANES.includes(o.pane as LandingPane)) out.pane = o.pane as LandingPane | null;
  if (opts.account && out.account && out.account !== opts.account) return null;
  return out;
}

/** What is open, as the shell sees it. */
export interface OpenNow {
  /** The conversation open (or under the panes). */
  conv: string | null;
  channel?: string | null;
  panes: Partial<Record<LandingPane, boolean>>;
  /** Settings' page, where the shell knows it. */
  section?: string | null;
  /** A wide layout: a pane sits BESIDE the chats, so the conversation is still
   *  there when it closes. A narrow one: a pane covers the chats, and closing
   *  it goes back to the list. */
  chatBeside: boolean;
}

/** Which pane is on screen when several say open: the garden covers whatever
 *  is under it, and the wallet wins over Settings. */
const ON_TOP: readonly LandingPane[] = ["garden", "wallet", "moments", "settings"];

/** The landing for "where the person is now" — what a reload by hand keeps. */
export function landingOf(now: OpenNow): Landing {
  const pane = ON_TOP.find((p) => now.panes[p]);
  const conv = !pane || now.chatBeside ? now.conv : null;
  const out: Landing = pane ? { pane, conv } : { conv };
  if (pane === "settings") out.section = now.section ?? null;
  if (conv && now.channel) out.channel = now.channel;
  return out;
}

/** A conversation's or a message's id: a strict UUID, in either case — so an
 *  ordinary markdown anchor (`#section`, a footnote) never passes for one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `@` and a username (an agent's carries its owner: `ops:helper`). */
const HANDLE = /^@[a-z0-9_][a-z0-9_.:-]{0,63}$/i;

/**
 * The place a URL hash names — as the web app reads it on load (mafold-web
 * AppShell `openFromHash`) and when a link in a message is clicked (mafold-web
 * lib/appHash.ts `isAppHash`: a place stays in the app), and as the desktop
 * shell keeps it across a restart into a new version (mafold-desktop
 * relaunch.ts): `#garden` and `#moments` (their longer links `#garden/…`
 * too), `#<conversation>`, `#<conversation>/<message>` (nothing past the
 * message is read). Anything else is no place: none, a markdown anchor, an
 * invite (`#join/…`, which the web app claims before it asks here), a query.
 */
export function landingFromHash(hash: string): Landing | null {
  const raw = hash.replace(/^#/, "").trim();
  if (raw === "garden" || raw.startsWith("garden/")) return { pane: "garden" };
  if (raw === "moments" || raw.startsWith("moments/")) return { pane: "moments" };
  // `#@username`: the chat with that person, whether or not one exists yet
  // (dmPrivacy.ts `pendingDmId`) — what the public profile's Message links to.
  if (HANDLE.test(raw)) return { conv: raw.toLowerCase() };
  const [conv, msg] = raw.split("/", 2);
  if (!conv || !UUID.test(conv) || (msg && !UUID.test(msg))) return null;
  return msg ? { conv, msg } : { conv };
}

/** The hash the web app writes for `to`, which `landingFromHash` reads back:
 *  the garden over the moments over the conversation (and the message in it),
 *  as a wide layout shows them. The wallet and Settings have no hash of their
 *  own — only the conversation under them, or none. */
export function landingHash(to: Landing): string {
  if (to.pane === "garden" || to.pane === "moments") return `#${to.pane}`;
  return to.conv ? `#${to.conv}${to.msg ? `/${to.msg}` : ""}` : "";
}

/** The URL a web page's reload asks for: same page, and the conversation in
 *  the hash the app already reads on load. The pane rides in storage instead
 *  (`keepLanding`) — a word in the hash would be a link any message could
 *  carry. (The desktop shell's restart brings back the hash the page showed,
 *  the garden's and the moments' too: mafold-desktop relaunch.ts.) */
export function landingUrl(loc: { pathname: string; search: string }, to: Landing): string {
  return loc.pathname + loc.search + landingHash({ conv: to.conv, msg: to.msg });
}
