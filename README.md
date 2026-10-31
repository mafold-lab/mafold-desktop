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
| `appearance`, `locale` | the window chrome, tray and menus follow the page's theme and language; the window stands on the app's own ground ([`client-shared/appGround.ts`](../client-shared/appGround.ts)), and the theme is kept so the next launch opens in it |
| `autostart` | open at login |
| `resume` | `on("resume")` — the machine woke up / the screen unlocked |
| `daemon` | `daemon.status / enable / disable`, `on("daemon")` — run bots on this computer: the shell installs mafold-cli to `~/.mafold`, signs it in (a device code the page approves), gets it the connections key and starts its supervisor. Never touches a supervisor registered to another binary (`foreign`) |
| `window-controls` | macOS only. `setWindowControls()`, `windowControl()`, `on("window")` — the window has no title bar; the page draws the close / minimise / zoom lights where mafold-mac drew them (a 58×44 pill at the head of the chat list, mafold-web `WindowLights.tsx`) and the system's own hide while it does. A page that doesn't draw them gets the system's in that same slot (`src/main/chrome.ts`) |
| `update` | `on("update")`, `update.state / install / check` — the shell's own new version: checking, downloading (percent), ready (stays ready until the restart), error; restart into a ready one; check now (at most once a minute). The state comes again whenever the page starts listening (`src/main/updateState.ts`). A page that listens offers the restart itself: while the window is in front (shown, not minimised, focused) the shell posts no notification, and the tray's / menu's "Restart to Update" reach it as an `ask` (it knows what a restart would cut off); a page that listens to nothing (or no longer — its `off` tells the shell), is on its way out to another document, or stopped answering gets the restart at once. The restart comes back where the person was: the new version opens on the conversation (the garden, the moments) the window showed — the hash the web app writes, never the query, if it is under ten minutes old — in the window's place; and its first run says which version it came from (`updatedFrom`) (`src/main/relaunch.ts`) |

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
  updateState.ts the shell's update as the page hears it (pure, unit-tested)
  relaunch.ts    where a restart into a new version comes back to (the hash,
                 read as the web app reads it: client-shared/reloadLanding.ts),
                 and the version it came from (pure + two files in userData,
                 unit-tested)
  cover.ts       开窗先画加载画面:窗口当场出来,上面盖一层只放静止画面的子视图
                 (网页第一帧那一张,client-shared/loadingFrame.ts),网页 DOM 好了
                 再撤、关掉;加载失败转离线页时马上撤;页面提交了迟迟不好,从
                 提交起 20 秒兜底(还没提交就一直盖着)。画什么、什么时候撤在
                 coverPlan.ts(pure, unit-tested)
src/preload/   the page-side half of mafoldHost (bundled into one file)
static/        offline page; strings.json (generated: the desktop.* langpack keys)
resources/     tray and window icons, shipped as real files
build/         app icons, macOS entitlements (app / helpers), the Developer ID profile
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
  (other origins), popups and the offline page get nothing. Nor does the
  loading cover over the window while the page arrives (`cover.ts`): a still
  `data:` page with JavaScript off, no preload, a CSP that lets in only inline
  styles and `data:` images, every navigation and popup refused, outside the
  page's session — closed as soon as the page is there.
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
  The app (not its helpers) claims the passkey keychain group
  `UGZPUZZYDD.com.mafold.desktop.webauthn` (`src/main/webauthn.ts`), a
  restricted entitlement authorised by `build/Mafold_Desktop_DeveloperID.provisionprofile`
  (App Store Connect profile "Mafold Desktop Developer ID", MAC_APP_DIRECT,
  bundle id `com.mafold.desktop`). The profile names the signing certificate
  (serial `1E54ECA2B6577088`, expires 2027-02-01): a new certificate needs a new
  profile, or macOS refuses to launch the build — the release job checks that
  the app starts.
- **Windows**: per-user NSIS installer, x64, not code-signed.
- Uploads to `cdn.mafold.com/desktop/stable/` (the update feed and the
  `/download` page's fixed names) and a GitHub Release there. A beta version
  goes to the beta machines only (below).

The bundled mafold-cli is pinned in `cli.lock.json` (version + sha256 per
target) and fetched by `scripts/fetch-cli.mjs`; the build refuses a cli that
cannot answer `mafold status --json`. Moving to a newer cli is a one-line change
to that file after a `cli@` release.

### Beta

A second release line, for the few machines that opted in, so a new shell is
lived with before everyone gets it. It shares the one feed folder
(`cdn.mafold.com/desktop/stable/`); the two lines are told apart by
electron-updater's own channel files — stable reads `latest-mac.yml` /
`latest.yml`, beta reads `beta-mac.yml` / `beta.yml`
(`src/main/updateChannel.ts`).

**Putting a machine on beta** is one file in the shell's data directory, then
quitting Mafold and opening it again. There is no setting for it in the app —
nobody lands on beta by a click — so the file is the only way:

```sh
# macOS (Terminal)
echo '{"channel":"beta"}' > ~/Library/Application\ Support/Mafold/update-channel.json
```

```powershell
# Windows (PowerShell)
Set-Content -Path "$env:APPDATA\Mafold\update-channel.json" -Value '{"channel":"beta"}'
```

(The folder is there once Mafold has run. Any plain-text editor does the
same: that file, that one line.) At launch
the shell's log — `~/Library/Logs/Mafold/main.log`,
`%APPDATA%\Mafold\logs\main.log` — says `updates: the beta channel`; without
that line the machine is on stable. No file, an unreadable one, or anything
else in it is stable. Deleting the file goes back to stable without a
downgrade: the machine keeps the beta it has until a stable release is newer
(`X.Y.Z` is newer than every `X.Y.Z-beta.N`).

Two things to know first. Shells up to 0.1.3 don't read the file: install the
first beta by hand — its dmg / exe is on its GitHub prerelease in
`mafold-lab/mafold-desktop` — and from then on it updates itself on the beta
line. And the CDN has no `beta*.yml` until the first release published with
this `scripts/r2-publish.sh` (stable or beta); before that a beta machine's
checks fail with a 404 in the log, and it stays on what it has.

**Publishing a beta**, by hand only (the release train refuses one):

1. `package.json` → `X.Y.Z-beta.N`, N from 1, where `X.Y.Z` is the next stable
   version: newer than the latest `desktop@X.Y.Z` out (`release-desktop.yml`
   refuses any other — a beta of a version that shipped, or of one behind it,
   would be older than what everyone has; the monorepo's
   `scripts/release/test_desktop_version_guard.py` runs that check).
   Merge.
2. Push the tag `desktop@X.Y.Z-beta.N` on that commit (the shape of every
   desktop tag: it must equal `package.json`). The public repo gets
   `vX.Y.Z-beta.N`, builds it like any release, and publishes the versioned
   files and `beta-mac.yml` / `beta.yml` (electron-builder names the feeds
   after the version's `beta`); its GitHub Release is a prerelease.
3. The next beta bumps N. When it is good, `package.json` → `X.Y.Z` and ship
   it as always (train or tag); the beta machines get it too.

Every stable release also goes up as `beta*.yml`, so the beta machines get
every stable release; a stable release after a newer beta takes the beta feed
back to that release (machines already on the beta keep it) until the next
beta is pushed.

**Why a stable machine can't tell any of this happened:**

- With no file, the shell hands electron-updater exactly the feed it always
  did and fetches `latest-mac.yml` / `latest.yml` — the URLs are pinned in
  `test/updateChannel.spec.ts` through electron-updater's own provider, and
  `test/updater.spec.ts` starts the updater as a packaged shell and checks
  what it hands `setFeedURL`.
- A beta never writes `latest*.yml` or the `/download` page's fixed names.
  `scripts/r2-publish.sh` decides by the version, refuses anything that is
  neither `X.Y.Z` nor `X.Y.Z-beta.N`, a feed announcing another version, or
  a build carrying the other line's feeds — before uploading anything
  (`test/r2Publish.spec.ts` runs it).
- A stable release uploads what it always did, in the same order, and the two
  beta copies after (`test/r2Publish.spec.ts` holds every upload to its
  source file and its place).
- The release train never carries a beta, and a beta's tag is not "the last
  release" when it numbers the next one (the monorepo's
  `scripts/release/train-preflight.sh`, tested beside it in
  `test_train_preflight.py`).
- A beta's GitHub Release is a prerelease, never "Latest".
