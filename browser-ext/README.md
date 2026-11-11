# Mafold Browser Import (Chrome extension)

A small Chrome extension, published to the Chrome Web Store, that lets the Mafold
**desktop app** read the sign-ins for a few sites the person picks — on
**Windows**, where the app can't read Chrome's cookies itself.

## Why it exists

The desktop app's **Browser** connection imports the sign-ins for sites you
choose, so your agents can work in them inside Mafold's own browser.

- **macOS:** the app reads Chrome (and Safari) directly. No extension.
- **Windows:** Chrome encrypts its cookie file with
  [app-bound encryption](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html),
  so no other app can decrypt it. The only supported way to read those cookies
  is to ask Chrome itself — through an extension. That is this.

Only **cookies** cross over (not `localStorage`), so a site that keeps its login
in site data will still ask you to sign in once inside Mafold. Same as the demo
said.

## How it works

```
Mafold desktop app ──(local native-messaging pipe)──► this extension ──► chrome.cookies
         ▲                com.mafold.import                                     │
         └──────────────── cookies for the picked sites ◄────────────────────────┘
```

1. In the app, under **Connections ▸ Browser**, the person taps **Choose sites**
   and ticks the sites to share.
2. The app sends that list to the extension over a **native-messaging** host,
   `com.mafold.import`, that the app installs and that relays to the running app.
   Nothing opens a network port; nothing leaves the machine.
3. The extension shows the person the picked sites in its popup and asks them to
   approve. Approving triggers Chrome's own **host-permission** prompt for
   exactly those sites — nothing wider.
4. The extension reads those sites' cookies with `chrome.cookies` and sends them
   back down the same pipe to the app.

The extension **never** injects into a page, reads a site the person didn't
pick, or touches the network. Uninstalling it leaves nothing behind.

## Files

| File | What it is |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `cookies`, `nativeMessaging`, `storage`; host access is **optional**, requested per-site at import time. |
| `background.js` | The service worker: holds the native port, the pending offer, and the collect step. |
| `popup.js` / `popup.html` | The person-facing approval: the picked sites, the Share button, the per-site grant. |
| `pack.js` | Pure helpers (host/apex parsing, cookie shaping, offer validation) — no Chrome, no DOM. |
| `pack.test.mjs` | Tests for `pack.js`. `node --test`. |
| `com.mafold.import.sample.json` | The native-messaging host manifest the **desktop app** writes at install, with the real binary path and the published extension id filled in. |
| `icons/` | 16 / 32 / 48 / 128 px. |
| `store/` | The Chrome Web Store listing: description, per-permission justification, and the data-use/privacy answers the review asks for. |

## The native-messaging host (desktop side — not built here)

This extension talks to host `com.mafold.import`. The desktop app is responsible
for installing that host's manifest (see `com.mafold.import.sample.json`) so
Chrome will launch it, and for relaying its stdio to the running app. That half
lands with the Browser-import build; this package is the extension and its
listing only, shipped first so the Web Store review can start.

### Wire protocol (v1)

JSON messages, native-messaging framing.

- **app → extension**
  - `{"v":1,"type":"offer","sites":[{"origin":"https://x.com","label":"X"}]}`
  - `{"v":1,"type":"cancel"}`
- **extension → app**
  - `{"type":"hello","protocol":1,"extVersion":"0.1.0"}` on connect
  - `{"type":"cookies","protocol":1,"origin":"https://x.com","at":<ms>,"cookies":[…]}` per site
  - `{"type":"done","protocol":1,"granted":[…origins],"skipped":[…origins]}`

Each wire cookie: `name, value, domain, path, secure, httpOnly, sameSite,
hostOnly, session`, and `expirationDate` (seconds) for non-session cookies.

## Test

```sh
node --test            # pack.js
```

## Publishing

See `store/`. First publish needs a Chrome Web Store developer account (a
one-time $5 registration) on the Mafold Google account; a cookie-reading
extension draws a closer review, so budget several days. Pin the extension id by
committing the manifest `key` before first upload, so `com.mafold.import`'s
`allowed_origins` can name it ahead of time.
