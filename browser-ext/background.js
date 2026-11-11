// Mafold Browser Import — service worker.
//
// WHAT THIS DOES, AND WHAT IT DOESN'T
// The Mafold desktop app can read Chrome's cookie file directly on macOS, but on
// Windows Chrome's app-bound encryption stops any other app decrypting it. So on
// Windows the app asks Chrome itself — through this extension — for the cookies
// of the handful of sites the person picked in the app's "Choose sites" screen.
//
// The person picks the sites in the app. The app sends that list here over a
// native-messaging port (host `com.mafold.import`, which the app installs and
// which relays to the running app on this machine — nothing opens a network
// port, nothing leaves the computer). This extension does three things and no
// more:
//   1. holds the offer and nudges the person to open the popup (a grant needs a
//      click);
//   2. after they approve in the popup, requests host permission for exactly
//      those sites and reads their cookies with chrome.cookies;
//   3. sends the cookies back down the same port to the app.
// It never reads a site the person didn't pick, never injects into pages, and
// never talks to the network. Remove it and nothing of it is left behind.

import {
  parseOffer,
  matchPatternsForOrigin,
  cookieQueryForOrigin,
  bundleForOrigin,
} from "./pack.js";

const HOST = "com.mafold.import";
const PROTOCOL = 1;

/** The one live offer, if any, kept in session storage so the popup and a
 *  restarted worker see the same thing. */
const OFFER_KEY = "offer";

let port = null;

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    return null;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // The app isn't running, or the host isn't installed. Clear any stale
    // offer so the popup doesn't show a dead one.
    void setOffer(null);
  });
  send({ type: "hello", protocol: PROTOCOL, extVersion: chrome.runtime.getManifest().version });
  return port;
}

function send(msg) {
  const p = connect();
  if (!p) return false;
  try {
    p.postMessage(msg);
    return true;
  } catch {
    port = null;
    return false;
  }
}

async function setOffer(offer) {
  if (offer) await chrome.storage.session.set({ [OFFER_KEY]: offer });
  else await chrome.storage.session.remove(OFFER_KEY);
  await paintBadge();
}

async function getOffer() {
  const got = await chrome.storage.session.get(OFFER_KEY);
  return got[OFFER_KEY] ?? null;
}

async function paintBadge() {
  const offer = await getOffer();
  const n = offer ? offer.sites.length : 0;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  if (n) await chrome.action.setBadgeBackgroundColor({ color: "#e8603c" });
}

function onHostMessage(msg) {
  const offer = parseOffer(msg);
  if (offer) {
    // A new ask from the app. Keep it for the popup; the person approves there.
    void setOffer(offer.sites.length ? offer : null);
    return;
  }
  // The app can also cancel.
  if (msg && msg.type === "cancel") void setOffer(null);
}

// The popup asks us to collect, once the person has approved in it (so the
// chrome.permissions.request below already ran under their click).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== "collect") return;
  collect(Array.isArray(msg.origins) ? msg.origins : [])
    .then((r) => reply(r))
    .catch((e) => reply({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async reply
});

async function collect(origins) {
  const granted = [];
  const skipped = [];
  for (const origin of origins) {
    const patterns = matchPatternsForOrigin(origin);
    const has = await chrome.permissions.contains({ origins: patterns });
    if (!has) {
      skipped.push(origin);
      continue;
    }
    const query = cookieQueryForOrigin(origin);
    const cookies = query ? await chrome.cookies.getAll(query) : [];
    send({ type: "cookies", protocol: PROTOCOL, ...bundleForOrigin(origin, cookies) });
    granted.push({ origin, count: cookies.length });
  }
  send({ type: "done", protocol: PROTOCOL, granted: granted.map((g) => g.origin), skipped });
  await setOffer(null);
  return { ok: true, granted, skipped };
}

// Keep the worker's port alive while Chrome is up, and reconnect after the
// worker is respun.
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
