# mafold-desktop

Mafold for macOS and Windows: an Electron shell around the **live** web app.

The window shows `https://mafold.com/app` — the same build every browser gets,
so a `web@` release updates the desktop app too. The shell adds only what a tab
cannot do, and hands it to the page through one object, `window.mafoldHost`:

| capability | what the page gets |
|---|---|
| `badge` | `setUnread()` → dock badge (macOS), taskbar overlay (Windows), the tray's unread list |
| `notify` | `notify()` → an OS notification; a click focuses the window at that conversation |
| `navigate` | `on("navigate")` — `mafold://app#<hash>` links, notification and tray clicks |
| `commands` | `on("command")` — the native menu's shortcuts (⌘N, ⌘K, ⌘L, ⌘,, ⌘⌥↑↓) |
| `oauth-external` | `oauth()` — third-party sign-in in the system browser, back over `mafold://link` |
| `external-links` | `openExternal()` |
| `appearance`, `locale` | the window chrome, tray and menus follow the page's theme and language |
| `autostart` | open at login |
| `resume` | `on("resume")` — the machine woke up / the screen unlocked |
| `daemon` | `daemon.status / enable / disable`, `on("daemon")` — run bots on this computer: the shell installs mafold-cli to `~/.mafold`, signs it in (a device code the page approves), gets it the connections key and starts its supervisor. Never touches a supervisor registered to another binary (`foreign`) |
| `window-controls` | macOS only. `setWindowControls()`, `windowControl()`, `on("window")` — the window has no title bar; the page draws the close / minimise / zoom lights where mafold-mac drew them (a 58×44 pill at the head of the chat list, mafold-web `WindowLights.tsx`) and the system's own hide while it does. A page that doesn't draw them gets the system's in that same slot (`src/main/chrome.ts`) |

The contract lives once, in [`client-shared/desktopHost.ts`](../client-shared/desktopHost.ts);
this package and mafold-web compile generated copies of it. The page uses the
bridge **by capability** (`host?.caps.includes("notify")`), never by asking
"am I in Electron".

## Layout

```
src/main/      the main process — window, security, bridge, tray, menu, …
  policy.ts      what may be navigated to / opened / granted (pure, unit-tested)
  validate.ts    every bridge payload reduced to a known shape (pure, unit-tested)
  oauth.ts       the table of OAuth states this shell issued (pure, unit-tested)
src/preload/   the page-side half of mafoldHost (bundled into one file)
static/        offline page; strings.json (generated: the desktop.* langpack keys)
resources/     tray and window icons, shipped as real files
build/         app icons, macOS entitlements
test/          unit tests (vitest, plain node)
e2e/           a real Electron window against local fixture origins (Playwright)
```

## Security model

- **One origin.** The main window shows the web origin and nothing else; every
  other http(s) page goes to the system browser, `<api>/download/*` becomes a
  download, every other scheme is refused.
- **The bridge exists only on the web origin's top frame.** The preload checks
  the document's origin before exposing anything, and the main process checks
  every message's sender again (`bridge.ts` `fromOurPage`): the main window's
  main frame, on the web origin. Cards (sandboxed srcdoc frames), mini-apps
  (other origins), popups and the offline page get nothing.
- **Everything the page sends is untrusted** — cards run in the page's realm.
  Payloads are validated and clipped; `openExternal` and popups are rate-limited;
  confirmation dialogs use build-time strings only (`Strings.frozen`).
- **OAuth results are accepted only for a state this shell issued**, once, within
  ten minutes. The PKCE verifier never leaves the page.
- **Unpackaged runs never touch the OS**: no `mafold://` registration, no login
  item, no updates, and only they read `MAFOLD_DESKTOP_*` overrides.
- Fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector, asar-only
  with integrity validation, encrypted cookies.

## Develop

```sh
npm ci
npm test            # unit tests
npm run typecheck
npm run e2e         # needs a display (CI runs it under xvfb)
MAFOLD_DESKTOP_WEB=http://localhost:3000 MAFOLD_DESKTOP_API=http://localhost:4000 npm start
```

The `desktop tests` workflow runs typecheck, unit tests and the e2e suite on
every push that touches this package, the contract, or the language packs.

## Release

`desktop@X.Y.Z` (= `package.json` version) on main → `release-desktop.yml`
mirrors this directory, with the generated contract and strings, to the public
repo `mafold-lab/mafold-desktop` and tags `vX.Y.Z` → that repo's
`.github/workflows/release.yml` (this tree's copy is the source) builds on free
runners:

- **macOS**: dmg + zip, arm64 and x64 in one run, Developer ID + notarized.
- **Windows**: per-user NSIS installer, x64, not code-signed.
- Uploads to `cdn.mafold.com/desktop/stable/` (the update feed and the
  `/download` page's fixed names) and a GitHub Release there.

The bundled mafold-cli is pinned in `cli.lock.json` (version + sha256 per
target) and fetched by `scripts/fetch-cli.mjs`; the build refuses a cli that
cannot answer `mafold status --json`. Moving to a newer cli is a one-line change
to that file after a `cli@` release.
