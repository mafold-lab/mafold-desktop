// Pure tests for pack.js — no Chrome, no DOM. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  originHost,
  apexDomain,
  matchPatternsForOrigin,
  cookieQueryForOrigin,
  toWireCookie,
  bundleForOrigin,
  parseOffer,
} from "./pack.js";

test("originHost", () => {
  assert.equal(originHost("https://www.X.com/path"), "www.x.com");
  assert.equal(originHost("https://x.com:8443"), "x.com");
  assert.equal(originHost("not a url"), "");
});

test("apexDomain", () => {
  assert.equal(apexDomain("www.x.com"), "x.com");
  assert.equal(apexDomain("x.com"), "x.com");
  assert.equal(apexDomain("a.b.c.github.com"), "github.com");
  assert.equal(apexDomain("foo.co.uk"), "foo.co.uk");
  assert.equal(apexDomain("www.foo.co.uk"), "foo.co.uk");
  assert.equal(apexDomain("localhost"), "localhost");
});

test("matchPatternsForOrigin: host + apex wildcard, https only", () => {
  assert.deepEqual(matchPatternsForOrigin("https://www.github.com"), [
    "https://www.github.com/*",
    "https://*.github.com/*",
  ]);
  // apex origin: still offers a subdomain wildcard for parent-domain cookies.
  assert.deepEqual(matchPatternsForOrigin("https://github.com"), [
    "https://github.com/*",
    "https://*.github.com/*",
  ]);
  assert.deepEqual(matchPatternsForOrigin("garbage"), []);
});

test("cookieQueryForOrigin queries the apex", () => {
  assert.deepEqual(cookieQueryForOrigin("https://mail.google.com"), { domain: "google.com" });
  assert.equal(cookieQueryForOrigin("garbage"), null);
});

test("toWireCookie keeps only the re-sendable fields", () => {
  const w = toWireCookie({
    name: "sid",
    value: "abc",
    domain: ".x.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    hostOnly: false,
    session: false,
    expirationDate: 123456,
    storeId: "0",
  });
  assert.deepEqual(w, {
    name: "sid",
    value: "abc",
    domain: ".x.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    hostOnly: false,
    session: false,
    expirationDate: 123456,
  });
  // session cookie: no expirationDate key at all
  assert.equal("expirationDate" in toWireCookie({ name: "a", value: "b", session: true }), false);
});

test("bundleForOrigin", () => {
  const b = bundleForOrigin("https://x.com", [{ name: "a", value: "1" }], 1000);
  assert.equal(b.origin, "https://x.com");
  assert.equal(b.at, 1000);
  assert.equal(b.cookies.length, 1);
  assert.equal(b.cookies[0].name, "a");
});

test("parseOffer cleans and drops junk", () => {
  assert.equal(parseOffer(null), null);
  assert.equal(parseOffer({ type: "cancel" }), null);
  const o = parseOffer({
    type: "offer",
    sites: [
      { origin: "https://www.x.com/feed", label: "X" },
      { origin: "garbage" },
      { nope: true },
      { origin: "https://y.com" },
    ],
  });
  assert.deepEqual(o, {
    sites: [
      { origin: "https://www.x.com", label: "X" },
      { origin: "https://y.com", label: "y.com" },
    ],
  });
});
