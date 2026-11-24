// Pure helpers — no `chrome.*`, no DOM — so they can be unit-tested in plain
// node (pack.test.mjs). Everything that touches a Chrome API lives in
// background.js / popup.js and calls through these.

// A short, deliberately small list of multi-part public suffixes we care about,
// so the apex of `foo.co.uk` is `foo.co.uk`, not `co.uk`. It is NOT the full
// Public Suffix List: it only needs to stop us requesting a wildcard over a
// whole registrar. For anything not listed we fall back to the last two labels,
// and if that is wrong the worst case is a slightly narrower cookie read, which
// the host-permission grant would reveal to the person anyway.
const MULTI_PART_SUFFIXES = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.jp", "or.jp", "ne.jp",
  "com.au", "net.au", "org.au", "com.cn", "net.cn", "org.cn", "com.hk",
  "com.tw", "com.br", "com.sg", "co.in", "co.kr", "co.nz", "co.za",
];

/** The host of an origin, lower-cased, no port. `""` if it can't be parsed. */
export function originHost(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The registrable domain ("apex") of a host: `www.x.com` -> `x.com`,
 *  `a.b.co.uk` -> `b.co.uk`. A bare host or IP is returned unchanged. */
export function apexDomain(host) {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  if (MULTI_PART_SUFFIXES.includes(lastTwo)) return labels.slice(-3).join(".");
  // lastThree would be e.g. `foo.co.uk` handled above; otherwise the apex is
  // the last two labels.
  void lastThree;
  return lastTwo;
}

/** The host-permission match patterns we ask the person to grant before we can
 *  read a site's cookies: the exact host and a wildcard over its apex, https
 *  only. The apex wildcard catches auth cookies parked on the parent domain
 *  (very common — `.google.com`, `.github.com`). */
export function matchPatternsForOrigin(origin) {
  const host = originHost(origin);
  if (!host) return [];
  const apex = apexDomain(host);
  const patterns = new Set([`https://${host}/*`]);
  if (apex && apex !== host) patterns.add(`https://*.${apex}/*`);
  else patterns.add(`https://*.${host}/*`);
  return [...patterns];
}

/** The `chrome.cookies.getAll` query for a picked site: every cookie whose
 *  domain is the apex or a subdomain of it. */
export function cookieQueryForOrigin(origin) {
  const host = originHost(origin);
  if (!host) return null;
  return { domain: apexDomain(host) };
}

/** One `chrome.cookies.Cookie` reduced to the wire shape the desktop app
 *  stores. We keep only what a browser needs to re-send the cookie; nothing
 *  about where it came from beyond the cookie itself. */
export function toWireCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite ?? "unspecified",
    hostOnly: !!c.hostOnly,
    session: !!c.session,
    // Chrome gives seconds; keep it as-is (the desktop side knows). Absent for
    // session cookies.
    ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
    // storeId is Chrome-internal and useless off this machine — dropped.
  };
}

/** The payload for one imported site. */
export function bundleForOrigin(origin, cookies, now = Date.now()) {
  return {
    origin,
    at: now,
    cookies: cookies.map(toWireCookie),
  };
}

/** Validate an `offer` message coming from the desktop app over the native
 *  port. We trust the host (it is ours), but a malformed message should never
 *  throw inside the service worker. Returns a clean `{sites}` or null. */
export function parseOffer(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.type !== "offer") return null;
  const sites = Array.isArray(msg.sites) ? msg.sites : [];
  const clean = [];
  for (const s of sites) {
    if (!s || typeof s.origin !== "string") continue;
    const host = originHost(s.origin);
    if (!host) continue;
    clean.push({ origin: `https://${host}`, label: typeof s.label === "string" ? s.label : host });
  }
  return { sites: clean };
}
