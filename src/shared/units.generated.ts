// GENERATED from client-shared/units.ts — DO NOT EDIT.
// ── How a number reads: durations, tokens, money, sizes and "how long ago" ──
// ONE copy for every TypeScript surface: the cards import this file directly
// (it is bundled into each card, so a change ships with the cards' hot
// update), mafold-rn imports it directly, mafold-web gets a generated copy
// (scripts/sync-shared.mjs). mafold-types/src/units.rs re-states the rules in
// Rust for the cli's terminal and the server's own sentences. Both test suites
// read client-shared/units.cases.json, so the two can't drift: change a rule,
// change a row.
//
// Before this file the same number was written forty different ways — a run
// that took an hour said "3702.9s", 25 million tokens said "25488.3k", and the
// cost said "$13.4366" right next to a wallet that said "$13.44". The rules
// (owner, 2026-10-22):
//
//   duration  850ms · 59.9s · 1m 1s · 1h 1m 43s · 1d 1h 1m      (at most three
//             units; trailing zero units dropped; rounded BEFORE the unit is
//             picked, so 59.95s is "1m", never "60.0s")
//   tokens    999 · 1.2K · 999.9K · 1M · 25.5M · 2.5B             (one decimal)
//   money     $1,235 · $13.44 · $0.43 · $0.0042 · $0.0001 · <$0.000001
//   bytes     500 B · 1.5 KB · 12.9 MB · 2.1 GB                    (1000 to the KB)
//   ago       just now · 5m ago · 3h ago · 2d ago
//
// The unit WORDS come from the language pack (`units.*`), so "1h 1m 43s" is
// "1 小时 1 分 43 秒" to a Chinese reader — chosen by the reader's language,
// never baked into a message by whoever wrote it. The tables below are the
// fallback for a pack that hasn't landed yet (same contract as a card's
// `defineStrings`: the worst case is English, never a raw key).
//
// All rounding is done on integers, so the TypeScript and Rust copies agree
// digit for digit (999,949 → "999.9K", 999,950 → "1M").

type Words = Record<string, string>;

const EN: Words = {
  "units.ms": "{n}ms",
  "units.s": "{n}s",
  "units.m": "{n}m",
  "units.h": "{n}h",
  "units.d": "{n}d",
  "units.K": "{n}K",
  "units.M": "{n}M",
  "units.B": "{n}B",
  "units.bytes.B": "{n} B",
  "units.bytes.KB": "{n} KB",
  "units.bytes.MB": "{n} MB",
  "units.bytes.GB": "{n} GB",
  "units.bytes.TB": "{n} TB",
  "units.ago.now": "just now",
  "units.ago.m": "{n}m ago",
  "units.ago.h": "{n}h ago",
  "units.ago.d": "{n}d ago",
  "units.agoShort.now": "now",
  "units.agoShort.m": "{n}m",
  "units.agoShort.h": "{n}h",
  "units.agoShort.d": "{n}d",
  "units.of.token": "{name} tokens",
  "units.of.second": "{name} seconds",
  "units.of.image": "{name} images",
  "units.of.other": "{name} {unit}",
  "units.one.token": "{name} token",
  "units.one.second": "{name} second",
  "units.one.image": "{name} image",
  "units.tokens": "{n} tokens",
};

const ZH: Words = {
  ...EN,
  "units.ms": "{n} 毫秒",
  "units.s": "{n} 秒",
  "units.m": "{n} 分",
  "units.h": "{n} 小时",
  "units.d": "{n} 天",
  "units.ago.now": "刚刚",
  "units.ago.m": "{n} 分钟前",
  "units.ago.h": "{n} 小时前",
  "units.ago.d": "{n} 天前",
  "units.agoShort.now": "刚刚",
  "units.agoShort.m": "{n} 分钟",
  "units.agoShort.h": "{n} 小时",
  "units.agoShort.d": "{n} 天",
  "units.of.token": "{name} token",
  "units.of.second": "{name} 秒",
  "units.of.image": "{name} 张",
  "units.one.token": "{name} token",
  "units.one.second": "{name} 秒",
  "units.one.image": "{name} 张",
  "units.tokens": "{n} token",
};

const BUNDLED: Record<string, Words> = { en: EN, "zh-Hans": ZH, zh: ZH };

/** Every `units.*` key with its bundled English and Chinese — what the language
 *  packs (mafold-api/langpacks/*.json) must carry. */
export const UNIT_WORDS: { en: Words; "zh-Hans": Words } = { en: EN, "zh-Hans": ZH };

type Pack = { lang?: string; strings?: Record<string, unknown> };

/** The active language pack — the same global the cards SDK, mafold-rn and
 *  mafold-web paint from. */
function activePack(): Pack | null {
  return ((globalThis as { __mafoldLang?: Pack }).__mafoldLang ?? null) as Pack | null;
}

function chain(lang: string): string[] {
  const out = [lang];
  const base = lang.split("-")[0];
  if (base && base !== lang) out.push(base);
  if (!out.includes("en")) out.push("en");
  return out;
}

/** `key` with `{n}` filled in. `lang` given → that language's bundled words
 *  (tests, and callers that format for someone other than the reader);
 *  otherwise the pack wins, then the bundled words for the pack's language. */
function word(key: string, n: string, lang?: string): string {
  return words(key, { n }, lang);
}

/** `word`, for a key with more than `{n}` in it (`{name}`, `{unit}`). */
function words(key: string, vars: Record<string, string>, lang?: string): string {
  let s: string | undefined;
  if (lang == null) {
    const p = activePack();
    const v = p?.strings?.[key];
    if (typeof v === "string") s = v;
    else if (v && typeof v === "object" && typeof (v as { other?: unknown }).other === "string") s = (v as { other: string }).other;
    lang = p?.lang || "en";
  }
  for (const l of chain(lang)) {
    if (s != null) break;
    s = BUNDLED[l]?.[key];
  }
  return (s ?? EN[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** Integer tenths → "12" / "12.5". */
function tenths(t: number): string {
  const whole = Math.floor(t / 10);
  const frac = t % 10;
  return frac === 0 ? String(whole) : `${whole}.${frac}`;
}

/** 1234567 → "1,234,567" (integers; the sign is kept). */
export function fmtGrouped(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(Math.abs(n));
  const digits = String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (n < 0 && r !== 0 ? "-" : "") + digits;
}

/**
 * Milliseconds → "850ms" / "12.3s" / "1m 1s" / "1h 1m 43s" / "1d 1h 1m".
 * Under a minute: one decimal of a second. From a minute up: whole seconds,
 * at most three units from the largest, a day and over drops the seconds.
 */
export function fmtDuration(ms: number, lang?: string): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const u = (n: number | string, k: string) => word(`units.${k}`, String(n), lang);
  const whole = Math.round(ms);
  if (whole < 1000) return u(whole, "ms");
  const t = Math.round(ms / 100);
  if (t < 600) return u(tenths(t), "s");
  let parts: [number, string][];
  const s = Math.round(ms / 1000);
  if (s < 3600) parts = [[Math.floor(s / 60), "m"], [s % 60, "s"]];
  else if (s < 86400) parts = [[Math.floor(s / 3600), "h"], [Math.floor((s % 3600) / 60), "m"], [s % 60, "s"]];
  else {
    const m = Math.round(ms / 60000);
    parts = [[Math.floor(m / 1440), "d"], [Math.floor((m % 1440) / 60), "h"], [m % 60, "m"]];
  }
  while (parts.length > 1 && parts[parts.length - 1][0] === 0) parts.pop();
  return parts.map(([n, k]) => u(n, k)).join(" ");
}

/**
 * A clock that ticks — a reply still being written, a task still running:
 * whole seconds that only ever count up ("0s" · "12s" · "1m 1s" · "1h 1m 42s"),
 * never "12.4s" one tick and "13.4s" the next.
 */
export function fmtElapsed(ms: number, lang?: string): string {
  const s = Math.floor(Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0);
  return s === 0 ? word("units.s", "0", lang) : fmtDuration(s * 1000, lang);
}

/** Seconds → the same as `fmtDuration`. */
export function fmtSeconds(secs: number, lang?: string): string {
  return fmtDuration(secs * 1000, lang);
}

/**
 * A count → "999" / "1.2K" / "999.9K" / "1M" / "25.5M" / "2.5B": one decimal,
 * ".0" dropped, rounded half-up before the tier is picked. Tokens, wallet
 * amounts, unread counts — any quantity read at a glance.
 */
export function fmtCompact(n: number, lang?: string): string {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(Math.abs(n));
  const sign = n < 0 && r !== 0 ? "-" : "";
  if (r < 1000) return sign + String(r);
  const tiers: [number, string][] = [[1e3, "K"], [1e6, "M"], [1e9, "B"]];
  for (let i = 0; i < tiers.length; i++) {
    const [unit, k] = tiers[i];
    const t = Math.floor((r * 10 + unit / 2) / unit);
    if (t < 10000 || i === tiers.length - 1) return sign + word(`units.${k}`, tenths(t), lang);
  }
  return sign + String(r);
}

/** Tokens read like any other count: "25.5M". */
export const fmtTokens = fmtCompact;

// ── Wallet amounts, said in full ───────────────────────────────────────────
// A wallet currency IS a model, and one of it is one output-equivalent unit of
// that model — a token for everything a vendor bills per token, a second of
// video or an image otherwise (the price row's `unit`, `walletRates`). A bare
// 「500K Opus 5.5」 leaves the reader asking 500K of what; the amount always
// says its unit (owner, 10-22). A list whose row title already IS the model's
// name (balances, a currency picker) keeps its bare number.

/** What one of a currency is: 「Opus 5.5 token」 / "Opus 5.5 tokens" /
 *  "Seedance 2 seconds". `unit` is the price row's (`walletRates`); missing —
 *  an older server, a row not priced yet — means token. A unit the words don't
 *  know reads as its own name. `count` 1 reads singular in English
 *  ("1 Sonnet 5 token = 0.240 Opus 5.5 tokens"). */
export function unitOf(name: string, unit?: string | null, lang?: string, count?: number): string {
  const u = unit || "token";
  const known = u === "token" || u === "second" || u === "image";
  const key = !known ? "units.of.other" : count === 1 ? `units.one.${u}` : `units.of.${u}`;
  return words(key, { name, unit: u }, lang);
}

/** An amount with its unit: 「+500K Opus 5.5 token」. `sign` puts "+" on a
 *  credit (a debit is always "−"); `grouped` writes every digit
 *  (「1,000,000 GPT-5.6 Terra token」) where the exact figure matters. */
export function fmtAmount(
  n: number,
  name: string,
  opts: { unit?: string | null; sign?: boolean; grouped?: boolean; lang?: string } = {},
): string {
  const digits = opts.grouped ? fmtGrouped(Math.abs(n)) : fmtCompact(Math.abs(n), opts.lang);
  const r = Math.round(Math.abs(n));
  const sign = n < 0 && r !== 0 ? "−" : opts.sign && r !== 0 ? "+" : "";
  return `${sign}${digits} ${unitOf(name, opts.unit, opts.lang, r)}`;
}

/** A count of tokens no single currency owns — a grant's monthly cap, what a
 *  listing sold: 「2M token」 / "2M tokens" (`grouped`: 「2,000,000 token」). */
export function fmtTokenCount(n: number, lang?: string, grouped = false): string {
  return word("units.tokens", grouped ? fmtGrouped(n) : fmtCompact(n, lang), lang);
}

/** `a` as an integer scaled by 10^d, half-up. */
function scaled(a: number, d: number): number {
  return Math.round(a * 10 ** d);
}

/** An integer scaled by 10^d → "12.34" (d ≥ 1). */
function fixed(v: number, d: number): string {
  const s = String(v).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/**
 * US dollars → "$1,235" / "$13.44" / "$0.43" / "$0.015" / "$0.0001" /
 * "<$0.000001". A dollar and up: cents (whole dollars from $1,000). Under a
 * dollar: two significant digits, at least two decimals — a wallet unit is a
 * fraction of a cent, and "$0.00" reads as "this has no price".
 */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "$0";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  const cents = scaled(a, 2);
  if (cents >= 100) {
    if (cents >= 100000) return `${sign}$${fmtGrouped(Math.round(a))}`;
    return `${sign}$${fixed(cents, 2)}`;
  }
  // The first scale with two whole digits BEFORE rounding — rounding first
  // would read $0.0099 as "0.010".
  let d = 2;
  while (a * 10 ** d < 10 && d < 6) d++;
  const s = scaled(a, d);
  if (s === 0) return `${sign}<$0.000001`;
  let out = fixed(s, d);
  // Two significant digits may leave a trailing zero ("0.0010") — drop it, but
  // never below cents ("0.50" stays).
  while (out.endsWith("0") && out.length - out.indexOf(".") - 1 > 2) out = out.slice(0, -1);
  return `${sign}$${out}`;
}

/** `fmtUsd` without its "$", for a sentence that writes its own: the price
 *  list's 「in ${in} · out ${out}」 → "in $15.00 · out $0.075". */
export function fmtUsdDigits(v: number): string {
  return fmtUsd(v).replace("$", "");
}

/**
 * Bytes → "500 B" / "1.5 KB" / "12.9 MB" / "2.1 GB": one decimal, and 1000 to
 * the KB — the way Finder, the iPhone's and Android's file managers count, so a
 * download says the same size here as on the reader's own device.
 */
export function fmtBytes(n: number, lang?: string): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  const r = Math.round(n);
  if (r < 1000) return word("units.bytes.B", String(r), lang);
  const tiers: [number, string][] = [[1e3, "KB"], [1e6, "MB"], [1e9, "GB"], [1e12, "TB"]];
  for (let i = 0; i < tiers.length; i++) {
    const [unit, k] = tiers[i];
    const t = Math.floor((r * 10 + unit / 2) / unit);
    // Rounded first: 999.96 KB is "1 MB", never "1000 KB".
    if (t < 10000 || i === tiers.length - 1) return word(`units.bytes.${k}`, tenths(t), lang);
  }
  return word("units.bytes.B", String(r), lang);
}

/** How long ago, in whole units: under a minute is "now". */
export function agoBucket(secs: number): { unit: "now" | "m" | "h" | "d"; n: number } {
  const s = Math.max(0, Math.floor(Number.isFinite(secs) ? secs : 0));
  if (s < 60) return { unit: "now", n: 0 };
  if (s < 3600) return { unit: "m", n: Math.floor(s / 60) };
  if (s < 86400) return { unit: "h", n: Math.floor(s / 3600) };
  return { unit: "d", n: Math.floor(s / 86400) };
}

/** Seconds since → "just now" / "5m ago" / "3h ago" / "2d ago". */
export function fmtAgo(secs: number, lang?: string): string {
  const b = agoBucket(secs);
  return word(`units.ago.${b.unit}`, String(b.n), lang);
}

/** Seconds since, where "ago" is already understood (a thread's last reply, a
 *  post's corner) → "now" / "5m" / "3h" / "2d" · 「刚刚 / 5 分钟 / 3 小时 / 2 天」. */
export function fmtAgoShort(secs: number, lang?: string): string {
  const b = agoBucket(secs);
  return word(`units.agoShort.${b.unit}`, String(b.n), lang);
}

/** The same, from an instant (ms since epoch, or an ISO string) to `now`. */
export function fmtAgoSince(at: number | string, now: number = Date.now(), lang?: string): string {
  const ms = typeof at === "string" ? Date.parse(at) : at;
  return fmtAgo((now - (Number.isFinite(ms) ? ms : now)) / 1000, lang);
}

// ── Reading back what older messages carry ─────────────────────────────────
// Every result card written before this file carries its numbers as English
// strings ("3702.9s", "25488.3k", "$13.4366"). Messages are never rewritten,
// so the card turns those back into numbers and formats them like a new one.

/** "3702.9s" / "48.3 s" / "850ms" / "1h 1m 43s" / "1h05m" → milliseconds. */
export function parseDuration(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const re = /(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)(?![a-z])\s*/y;
  let total = 0;
  for (let i = 0; i < s.length; ) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return undefined;
    total += parseFloat(m[1]) * unit[m[2]];
    i = re.lastIndex;
  }
  return total;
}

/** "25488.3k" / "1.2M" / "64K" / "2,500" / "999" → the count. */
export function parseCompact(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const m = /^\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*([kKmMbB]?)\s*$/.exec(raw);
  if (!m) return undefined;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as "" | "k" | "m" | "b"];
  return Math.round(parseFloat(m[1].replace(/,/g, "")) * mult);
}

/** "$13.4366" / "13.44" / "$1,235" → dollars. */
export function parseUsd(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const m = /^\s*(-?)\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return undefined;
  const v = parseFloat(m[2].replace(/,/g, ""));
  return m[1] ? -v : v;
}
