// GENERATED from client-shared/desktopHost.ts — DO NOT EDIT.
// The contract between the Mafold desktop shell (`mafold-desktop/`, Electron)
// and the web app it hosts (`mafold-web`, loaded live from the web origin).
//
// The shell exposes ONE object to the page, `window.mafoldHost`, and the page
// uses it BY CAPABILITY — `host?.caps.includes("notify")` — never by asking
// "am I in Electron". Without a shell the object is absent and every caller
// falls back to what a browser does, the same way the page already checks
// `"PushManager" in window`.
//
// One source, two generated copies (`mafold-web/scripts/sync-shared.mjs`,
// `mafold-desktop/scripts/sync-shared.mjs`): the channel names below are what
// the preload sends and what the main process listens for, so a drift between
// the two sides is a silent no-op — which is exactly why there is only one.
//
// No imports: this file is copied verbatim into both packages.

/** What a given shell build can do. A page checks before it calls. */
export const HOST_CAPS = [
  // `setUnread` drives the dock/taskbar badge and the tray's unread list.
  "badge",
  // `notify` shows an OS notification; a click focuses the window and navigates.
  // A page that sees it never offers Web Push: notifications in the app are the
  // shell's, and Electron has no push service (`pushManager.subscribe` always
  // rejects there).
  "notify",
  // `notify-settings` — `notifications`: whether the system lets the app show
  // notifications as far as the shell has seen, a test notification, and the
  // system's notification settings for the app (where a blocked app is allowed).
  "notify-settings",
  // `on("navigate")` — deep links, notification clicks, tray rows.
  "navigate",
  // `on("command")` — the native menu's shortcuts (⌘N, ⌘K, …).
  "commands",
  // `oauth()` — third-party authorization in the system browser, back over `mafold://link`.
  "oauth-external",
  // `openExternal()` — a link opened in the system browser.
  "external-links",
  // `setAppearance()` — the window chrome and tray follow the page's theme.
  "appearance",
  // `setLocale()` — the tray and menu follow the page's language.
  "locale",
  // `autostart` — open the app at login.
  "autostart",
  // `on("resume")` — the machine woke up or the network came back.
  "resume",
  // `daemon` — run bots on this computer: the shell installs mafold-cli and
  // manages its supervisor (see DaemonStatus).
  "daemon",
  // `bot-restart` — `daemon.restart(name)`: restart one bot on this computer
  // (mafold-cli's `restart`), counted once the shell reads its new process back.
  "bot-restart",
  // `mafold-relogin` — `daemon.relogin(username)`: sign a person whose Mafold
  // login here was refused (`mafold_signed_out`) in again, with a device code
  // the page approves; counted once the status no longer says it.
  "mafold-relogin",
  // `runtime-login` — `daemon.runtimeLogin(runtime)` / `runtimeLoginCode(code)`:
  // sign this computer's Claude Code in (mafold-cli's `runtime login`, the same
  // sign-in a bot's `/login` runs); the shell opens the sign-in page.
  "runtime-login",
  // `logs` — `daemon.logs` / `daemon.followLogs` / `daemon.diagnose`: the last
  // lines of the supervisor's log or one of the person's bots' (mafold-cli's
  // `logs`, which finds each), following what gets written, and a diagnostics
  // file (`diagnose`) saved where the person picks in the system's save dialog.
  "logs",
  // `cli-update` — mafold-cli's own version here: `daemon.checkUpdate` /
  // `updateCli` / `setAutoUpdate` / `setChannel` / `rollbackCheck` / `rollback`
  // (mafold-cli's `update` and `rollback`), each counted once this computer's
  // status reads it back. A rollback asks the person first in a native dialog.
  "cli-update",
  // `adopt` — `daemon.adoptCheck` / `daemon.adopt`: hand a computer whose bots
  // another mafold runs (`DaemonStatus.foreign`) to the shell (mafold-cli's
  // `up --adopt`), after the person agrees in a native dialog naming the bots
  // it restarts; counted once this computer's status reads back as the shell's.
  "adopt",
  // `window-controls` (macOS) — the window has no title bar; the page draws the
  // close / minimise / zoom lights itself (`setWindowControls`, `windowControl`)
  // where mafold-mac drew them, and hears `on("window")` for full screen.
  "window-controls",
  // `window-arrange` (macOS) — the green light does what the system's does:
  // full screen on a click, zoom with ⌥, and the move-and-resize menu on hover
  // (`windowControl` "fullscreen" / "fill" / "center" / "tile-left" / "tile-right").
  // Without it the page's green light is the original zoom and nothing else.
  "window-arrange",
  // `update` — the shell's own new version: `on("update")` (checking,
  // downloading, ready, error) and `update` (restart into it, check now). Only
  // the shell has a version to install: the page updates by being the live site.
  "update",
] as const;

export type HostCap = (typeof HOST_CAPS)[number];

export type HostOs = "macos" | "windows";

/** One unread conversation, as the tray menu lists it. */
export interface UnreadEntry {
  convId: string;
  title: string;
  preview: string;
  count: number;
}

/** What the badge counts (already filtered by mute + badge prefs) and the
 *  first few conversations behind it. */
export interface UnreadSummary {
  total: number;
  top: UnreadEntry[];
}

export interface HostNotification {
  convId: string;
  msgId?: string;
  title: string;
  body: string;
  silent: boolean;
}

/**
 * Whether the system lets the app show notifications. There is no system call
 * for it the shell can make, so this is what it has SEEN: the last notification
 * it showed (`allowed`) or the system refused (`blocked`). `unknown` until then,
 * and again after it opened the system's settings, where it may have changed.
 */
export type NotifyPermission = "allowed" | "blocked" | "unknown";

export type HostCommand =
  | "new-chat"
  | "quick-switcher"
  | "focus-composer"
  | "settings"
  | "next-chat"
  | "prev-chat";

export const HOST_COMMANDS: readonly HostCommand[] = [
  "new-chat",
  "quick-switcher",
  "focus-composer",
  "settings",
  "next-chat",
  "prev-chat",
];

export type Appearance = "light" | "dark" | "system";

export interface OAuthResult {
  code?: string;
  error?: string;
}

export type HostEventName = "navigate" | "command" | "resume" | "daemon" | "window" | "notify-permission" | "update" | "logs";

/**
 * The shell's own update, as far as it has got. `ready` stays until the shell
 * restarts into it: a later check, a failed one, or the same version downloaded
 * again does not take it back — only a different version replaces `next`.
 */
export interface HostUpdate {
  /** The running shell's version (`MafoldHost.version`). */
  current: string;
  phase: "idle" | "checking" | "downloading" | "ready" | "error";
  /** `downloading` / `ready`: the version on its way, or waiting for a restart. */
  next?: string;
  /** `downloading`: 0–100, whole numbers. */
  percent?: number;
  /** When a check last answered "nothing new" or "a new version" (ms since the
   *  epoch) — what "up to date" after a manual check rests on. Checks while a
   *  version is downloading or ready are no news and leave it as it was. */
  checkedAt?: number;
  /** The version this shell ran before, on its first run after updating —
   *  however it was installed (the restart, or quitting). Every state of that
   *  run carries it, and the page hears it again each time it starts
   *  listening: say "up to date" once per version. Not on a new install, a
   *  downgrade, or the first run after a shell that did not write its version
   *  down yet (0.1.3 and before). */
  updatedFrom?: string;
  /** Rides one event only, never `update.state()`: the person asked the tray
   *  or the menu to restart, and the page decides whether now is a good time. */
  ask?: true;
}

/** The window, as the page needs to draw its own controls. In full screen
 *  macOS hides the window's chrome, and the page hides its lights with it. */
export interface WindowState {
  fullscreen: boolean;
}

export type WindowAction =
  | "close"
  | "minimize"
  | "zoom"
  // `window-arrange` only:
  | "fullscreen"
  | "fill"
  | "center"
  | "tile-left"
  | "tile-right";

/** Every action, for validating what arrives over the bridge. */
export const WINDOW_ACTIONS: readonly WindowAction[] = ["close", "minimize", "zoom", "fullscreen", "fill", "center", "tile-left", "tile-right"];

/**
 * This computer as a place bots run (mafold-cli's supervisor, managed by the
 * shell). `foreign`: the supervisor here isn't the shell's to manage — see
 * {@link DaemonStatus.foreign} for why. The shell then only looks, never
 * starts, stops or updates it, because `mafold up` from another binary would
 * take the service over.
 */
export interface DaemonStatus {
  /** `outdated`: a mafold too old to report its status to the shell (before
   *  `status --json`); `enable` updates it first. `version`: the mafold on
   *  disk. `running`: the version the supervisor here runs, while one runs and
   *  says (absent from an older cli or shell) — an update or a rollback
   *  changes `version` first, and the two differ until the supervisor
   *  restarts onto it. */
  cli: { installed: boolean; version?: string; outdated?: boolean; running?: string };
  supervisor: "running" | "stopped" | "absent" | "foreign";
  /** `foreign` only: why, as mafold-cli's `supervisor.not_ours` says it (the
   *  page words each) — `elsewhere`: the service runs another install's mafold
   *  (Homebrew, a dev build, one that is gone) · `by_hand`: a supervisor no
   *  service manager started (`mafold supervise` in a terminal) ·
   *  `update_flag`: the service was set up with `--no-auto-update`, the old
   *  way to keep updates off — and whatever a newer cli adds. Turning
   *  automatic updates off in settings (`setAutoUpdate`) is none of these.
   *  An older shell says `foreign` without why. */
  foreign?: string[];
  /** People signed in on this computer (the supervisor serves all of them). */
  accounts: string[];
  /** This computer, as Mafold keys its rows (`HarnessHost.device_id`) — how
   *  the page tells this one from the person's other computers. Absent from a
   *  shell or a cli that doesn't say. */
  deviceId?: string;
  /** `pid`: the bot's process while it runs (absent from an older shell).
   *  `turnSince`: when the reply it is writing now began, epoch seconds. */
  bots: { name: string; harness: string; running: boolean; busy: boolean; pid?: number; turnSince?: number }[];
  /** `health`: can this runtime's login take a turn right now — the cli's own
   *  probe, as it said it. Absent from an older cli or shell, and for a
   *  runtime the cli doesn't probe. */
  harnesses: { id: string; available: boolean; version?: string; health?: RuntimeHealth }[];
  /** What needs a person on this computer, worst first — mafold-cli's
   *  `machine::issues`, codes as it says them (the page words them). Absent
   *  from an older cli or shell: that is "not said", not "nothing wrong". */
  issues?: MachineIssue[];
  /** mafold-cli's own updates. Absent from an older cli or shell. */
  update?: CliUpdate;
  /** "cached": this computer holds the connections key; "device": not yet. */
  vault: "cached" | "device" | "none";
  /** What the shell is doing about it right now. `error`: a
   *  {@link DaemonActionError} (an older shell sent what the command printed);
   *  `detail`: what it printed, for the log — never for the page. */
  task: null | { step: "install" | "login" | "unlock" | "start" | "stop" | "relogin"; error?: string; detail?: string };
}

/**
 * Why starting or stopping the bots on this computer didn't happen — or why it
 * can't be said that it did. It counts only once this computer's status reads
 * back as asked (running and signed in; stopped; signed out), never on a
 * command's exit code. The page words each (`desktop.action.*`); a code it
 * doesn't know — or an older shell's prose — reads as `failed`.
 * - `unverified`: the command ran, but the status read back didn't change
 * - `timeout`: the computer didn't answer in time
 * - `cli_missing`: no mafold here, and it couldn't be put in place
 * - `unsupported`: the mafold here is too old to be managed, and updating it failed
 * - `busy`: the shell is already starting or stopping it
 * - `foreign`: set up from the command line — the shell only looks
 * - `cancelled`: the person said no in the dialog
 * - `failed`
 */
export type DaemonActionError =
  | "unverified"
  | "timeout"
  | "cli_missing"
  | "unsupported"
  | "busy"
  | "foreign"
  | "cancelled"
  | "failed";

/**
 * A runtime login's state (mafold-types `SeatHealth`): `ok` · `exhausted` ·
 * `unauthenticated` · `rejected` · `unreachable` · `unknown` — a string, so a
 * newer cli's state this page hasn't heard of still arrives.
 */
export interface RuntimeHealth {
  state: string;
  /** When the cli last looked, epoch seconds. */
  checkedAt?: number;
  /** The windows a full plan has, most-occupied first (`resetsAt`: epoch seconds). */
  limits?: { kind: string; label?: string; percent?: number; resetsAt?: number }[];
}

/** One thing that needs a person on this computer (mafold-cli `machine::Issue`). */
export interface MachineIssue {
  /** `service_stopped` · `service_crash_loop` · `mafold_signed_out` ·
   *  `heartbeat_stale` · `runtime_missing` · `runtime_signed_out` ·
   *  `runtime_rejected` · `runtime_exhausted` · `bot_down` · `bot_crash_loop` ·
   *  `update_failing` — and whatever a newer cli adds. */
  code: string;
  scope: "machine" | "account" | "runtime" | "bot";
  /** The account, runtime, bot or version it is about. */
  subject?: string;
  /** The bots it keeps from answering. */
  bots?: string[];
  /** The logins it leaves this computer offline for. */
  accounts?: string[];
  /** Since when, epoch seconds, where that is known. */
  since?: number;
  /** `runtime_exhausted`: when it can be used again, epoch seconds. */
  until?: number;
}

/** mafold-cli's own updates, as `status --json` says them. */
export interface CliUpdate {
  /** `stable` · `dev` — a string, so a newer cli's channel still arrives. */
  channel: string;
  /** In effect: false while either the machine setting or the service keeps it off. */
  autoUpdate: boolean;
  /** The machine setting alone (`setAutoUpdate`), whatever the service does
   *  with it. Absent from an older cli or shell. */
  autoUpdateSetting?: boolean;
  /** A newer version than the one running, if one is offered. */
  available?: string;
  /** When a check last got an answer, epoch seconds. */
  checkedAt?: number;
  /** false: no mafold release is built for this computer — it can't update
   *  itself. Absent from an older shell. */
  supported?: boolean;
  /** Installing a newer version kept failing (twice or more in a row). */
  failed?: { version: string; error: string; since: number };
  /** A rollback's skip: automatic updates leave `version` (and anything
   *  older) alone until a newer release is out. `at`: when it rolled back,
   *  epoch seconds. */
  skipped?: { version: string; at: number };
}

/**
 * Why checking for, installing, rolling back or setting up mafold-cli's own
 * updates didn't happen — or why it can't be said that it did. Each counts only
 * once this computer's status reads it back, never on what the cli printed.
 * The page words each; a code it doesn't know reads as `failed`.
 * - `unverified`: the cli said done, but the status doesn't read it back (the
 *   version didn't change, a rollback's skip isn't on disk, a setting didn't stick)
 * - `not_restarted`: in place on disk, but the supervisor here didn't restart
 *   onto it in time (it waits for the replies it is writing, up to 5 minutes)
 * - `timeout`: the cli didn't answer in time
 * - `cli_missing`: no mafold here
 * - `outdated`: the mafold here is from before this (update it first)
 * - `unsupported`: no mafold release is built for this computer
 * - `foreign`: the supervisor here isn't the shell's to manage (`DaemonStatus.foreign`)
 * - `busy`: the shell is already doing something to this computer
 * - `no_backup`: no earlier version is kept here to go back to
 * - `too_old`: the earlier version is from before rollbacks could stick — it
 *   would update itself straight back
 * - `changed`: the versions the person agreed to in the rollback dialog
 *   weren't the ones here any more (an update landed meanwhile) — nothing was
 *   done; ask again
 * - `cancelled`: the person said no in the dialog
 * - `failed` · `refused` (the shell turned the call away)
 */
export type CliUpdateError =
  | "unverified"
  | "not_restarted"
  | "timeout"
  | "cli_missing"
  | "outdated"
  | "unsupported"
  | "foreign"
  | "busy"
  | "no_backup"
  | "too_old"
  | "changed"
  | "cancelled"
  | "failed"
  | "refused";

/** `checkUpdate` / `setChannel` / `setAutoUpdate`: this computer's updates as
 *  its status reads back afterwards — a check once `checkedAt` shows it, a
 *  setting once it shows as set. `latest`: the newest release the feed offers
 *  on the channel (a check; `setChannel` checks the new one) — absent when the
 *  check didn't read back. */
export type CliUpdateResult = { ok: true; update: CliUpdate; latest?: string } | { ok: false; error: CliUpdateError; detail?: string };

/** `rollbackCheck`: going back to `to` would stick (`from` skipped until a
 *  newer release is out). No rollback to offer: `no_backup` / `too_old`, or
 *  the mafold here can't say (`outdated`). */
export type CliRollbackCheck = { ok: true; from: string; to: string } | { ok: false; error: CliUpdateError; detail?: string };

/**
 * `updateCli` / `rollback`: the mafold here is `version` now, read back from
 * this computer's status (`updated`: it changed — false: it already was the
 * newest). `supervisor`: `on_it` — the supervisor here runs it, read back
 * (after the replies it was writing) · `none` — nothing runs bots here now; they
 * start on it · `later` — the supervisor here still runs another version and
 * wasn't moved onto this one: it takes no restart requests (from before
 * them), didn't take this one, or nobody asked it (the version was already in
 * place). It moves when it restarts or updates itself; `cli.running` says.
 */
export type CliInstallResult =
  | { ok: true; version: string; updated: boolean; supervisor: "on_it" | "none" | "later" }
  | { ok: false; error: CliUpdateError; detail?: string };

/**
 * Why this computer wasn't handed to Mafold (`adopt`) — or why it can't be
 * said that it was. It counts only once this computer's own status reads back
 * as the shell's, never on what the cli printed. The page words each; a code
 * it doesn't know reads as `failed`.
 * Nothing was changed:
 * - `base_differs`: the bots here talk to another Mafold (a dev server, …) —
 *   handing them over would move them to this one
 * - `base_unknown`: a supervisor started by hand that doesn't say which Mafold
 *   it talks to, so handing it over could move its bots to another one
 * - `no_service_manager`: the system's service manager can't be reached from
 *   here, so the old service would only start again
 * - `inside_bot`: asked from inside a bot's own reply, which it would cut off
 * - `not_set_up`: nothing runs bots here — nothing to hand over (`enable`)
 * - `changed`: this computer wasn't what the person agreed to in the dialog any
 *   more (a bot added or gone, the update setting changed) — ask again
 * - `cancelled`: the person said no in the dialog
 * - `cli_missing` · `outdated` (the mafold here is from before handing over)
 *   · `busy` (the shell is already doing something to this computer) ·
 *   `refused` (the shell turned the call away)
 * - `failed` · `timeout` from `adoptCheck`, or from `adopt` before the move
 * Moved, but not all the way:
 * - `not_registered`: running on the shell's mafold, but not registered to
 *   start at login — it won't survive a restart of the computer
 * - `bots_not_back`: a bot isn't running again (`detail` names it)
 * - `unverified`: the cli said done, but this computer's status doesn't read
 *   back as the shell's, every bot running again, updates as the dialog said
 * May have changed — this computer's status says where it is:
 * - `failed` · `timeout` from the move itself: it removes the old service and
 *   stops its supervisor and bots before starting the new one, and a failure
 *   after that leaves them stopped (`detail`: how far it got)
 */
export type AdoptError =
  | "base_differs"
  | "base_unknown"
  | "no_service_manager"
  | "inside_bot"
  | "not_set_up"
  | "changed"
  | "cancelled"
  | "timeout"
  | "cli_missing"
  | "outdated"
  | "busy"
  | "failed"
  | "refused"
  | "not_registered"
  | "bots_not_back"
  | "unverified";

/**
 * `adoptCheck`: what handing this computer to Mafold would do; changes
 * nothing. `state`: `adoptable` — another mafold runs the bots here (`reasons`,
 * as {@link DaemonStatus.foreign}), and `adopt` moves them · `managed` — the
 * shell's already · `not_set_up` — nothing runs bots here (`enable`).
 * `bots`: every bot here, each restarted once; `busy`: those writing a reply
 * now, which `adopt` waits for (up to 5 minutes). `autoUpdate`: whether it
 * updates itself afterwards — this computer's setting; the old
 * `--no-auto-update` doesn't come along.
 */
export type AdoptCheck =
  | { ok: true; state: "adoptable" | "managed" | "not_set_up"; reasons: string[]; bots: string[]; busy: string[]; autoUpdate: boolean }
  | { ok: false; error: AdoptError; detail?: string };

/**
 * `adopt`: this computer is the shell's now, read back — its supervisor runs
 * the shell's mafold, every bot in `bots` runs again as a new process, and it
 * updates itself as `autoUpdate` says (what the dialog said). `adopted`: false
 * — it already was, nothing moved. `cut`: bots still writing a reply when the
 * 5 minutes ran out, cut off.
 */
export type AdoptResult =
  | { ok: true; adopted: boolean; bots: string[]; cut: string[]; autoUpdate: boolean }
  | { ok: false; error: AdoptError; detail?: string };

export type DaemonEnableResult =
  /** Approve this device code as the signed-in person (`auth/device/approve`). */
  | { userCode: string }
  /** Already signed in here; the shell carries on by itself. */
  | { ready: true }
  /** A {@link DaemonActionError} (an older shell sent prose); `detail` is for the log. */
  | { error: string; detail?: string };

/** `daemon.disable`: done once the status reads back stopped (or this person
 *  signed out); else a {@link DaemonActionError}. */
export interface DaemonDisableResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

/**
 * Why a bot wasn't restarted — or why it can't be said that it was:
 * - `unverified`: asked, maybe done, but the new process couldn't be read back
 * - `unknown_bot`: no bot of that name runs on this computer
 * - `no_supervisor`: nothing runs bots here right now
 * - `supervisor_too_old`: the supervisor here takes no restart requests yet
 * - `outdated`: the mafold here has no `restart` at all
 * - `not_taken`: the supervisor didn't take the request (withdrawn, not done)
 * - `still_running`: the bot didn't stop, so it wasn't restarted
 * - `exited`: it started again and exited right away
 * - `not_yours`: the bot isn't the person's the page said it asks for
 * - `failed` · `refused` (the shell turned the call away)
 */
export type BotRestartError =
  | "unverified"
  | "unknown_bot"
  | "no_supervisor"
  | "supervisor_too_old"
  | "outdated"
  | "not_taken"
  | "still_running"
  | "exited"
  | "not_yours"
  | "failed"
  | "refused";

export type BotRestartResult =
  /** `interrupted`: replies it was writing; the new process picks them up. */
  | { ok: true; oldPid?: number; newPid: number; interrupted: number }
  | { ok: false; error: BotRestartError; detail?: string };

/**
 * Why signing a runtime in on this computer didn't happen — or why it can't be
 * said that it did (the page words each; a code it doesn't know reads as `failed`):
 * - `unverified`: the sign-in went through, but this computer's status still
 *   says the runtime needs signing in
 * - `unsupported`: not a runtime the shell signs in (only `claude-code`)
 * - `runtime_missing`: it isn't installed on this computer
 * - `outdated`: the mafold here has no `runtime login`
 * - `cli_missing`: no mafold here
 * - `no_link`: no sign-in link came
 * - `no_code`: no code came back in time
 * - `rejected`: the runtime refused the code
 * - `cancelled`: stopped before it finished (`runtimeLoginCancel`, another
 *   `runtimeLogin`, the app quitting)
 * - `not_started`: a code with no sign-in waiting for one
 * - `failed` · `refused` (the shell turned the call away)
 */
export type RuntimeLoginError =
  | "unverified"
  | "unsupported"
  | "runtime_missing"
  | "outdated"
  | "cli_missing"
  | "no_link"
  | "no_code"
  | "rejected"
  | "cancelled"
  | "not_started"
  | "failed"
  | "refused";

/** `runtimeLogin`: the sign-in page is open in the system browser (`opened`;
 *  false = it couldn't be, show `url`) and the runtime waits for the code. */
export type RuntimeLoginStart = { url: string; opened: boolean } | { error: RuntimeLoginError; detail?: string };

/** `runtimeLoginCode`: signed in, and this computer's status reads it back.
 *  `email`: who the login is now, where the runtime said. */
export type RuntimeLoginResult = { ok: true; email?: string } | { ok: false; error: RuntimeLoginError; detail?: string };

/**
 * Why a log wasn't read, a follow stopped, or no diagnostics file was written
 * (the page words each; a code it doesn't know reads as `failed`):
 * - `not_yours`: the bot isn't the person's the page said it asks for — or,
 *   for the supervisor's log, that person isn't signed in on this computer
 * - `unknown_bot`: no bot of that name runs on this computer
 * - `no_log`: nothing has been written to that log yet
 * - `outdated`: the mafold here has no `logs` / `diagnose`
 * - `cli_missing`: no mafold here
 * - `cancelled`: the person closed the save dialog
 * - `unverified`: the cli said it wrote the file, but it isn't there as said
 * - `replaced`: a newer follow took over (one at a time)
 * - `closed`: the window closed, or the page went away
 * - `failed` · `refused` (the shell turned the call away)
 */
export type LogError =
  | "not_yours"
  | "unknown_bot"
  | "no_log"
  | "outdated"
  | "cli_missing"
  | "cancelled"
  | "unverified"
  | "replaced"
  | "closed"
  | "failed"
  | "refused";

/** Lines of a log, oldest first. Each is at most 4000 characters (a longer one
 *  is cut, ending in `…`); `skipped`: older lines left out to keep it small. */
export type LogTail = { ok: true; lines: string[]; skipped?: number } | { ok: false; error: LogError; detail?: string };

/**
 * One frame of a followed log (`followLogs`): at most four a second, each at
 * most 64 KB. `skipped`: lines dropped because they came faster than that —
 * the oldest go first. `rotated`: the log moved aside (past 10 MB) and a fresh
 * one began. `end`: it stopped — `done` if the cli finished by itself — and no
 * frame comes after it.
 */
export interface LogFrame {
  lines?: string[];
  skipped?: number;
  rotated?: true;
  end?: LogError | "done";
}

/** `diagnose`: written where the person picked (`name`: the file's name), and
 *  read back there as big as the cli said. Nothing in it reaches the page. */
export type DiagnoseResult = { ok: true; name: string; bytes: number; masked: number } | { ok: false; error: LogError; detail?: string };

export interface MafoldHost {
  readonly kind: "desktop";
  /** The shell's own version (not the web's). */
  readonly version: string;
  readonly os: HostOs;
  readonly caps: readonly HostCap[];

  setUnread(u: UnreadSummary): void;
  notify(n: HostNotification): void;
  /** http(s), mailto: and tel: only; anything else is dropped. */
  openExternal(url: string): void;
  /** Open `authorizeUrl` in the system browser and resolve with what the
   *  provider sent back to `/app/link/callback`. `state` must carry
   *  `DESKTOP_STATE_PREFIX` — that prefix is how the callback page, running in
   *  the system browser, knows to hand the result to `mafold://link`. */
  oauth(authorizeUrl: string, state: string): Promise<OAuthResult>;
  /** The page's language and the `desktop.*` strings it resolved. Used for the
   *  tray and menus only — never for a confirmation dialog. */
  setLocale(lang: string, strings: Record<string, string>): void;
  setAppearance(mode: Appearance): void;
  on(ev: "navigate", cb: (hash: string) => void): () => void;
  on(ev: "command", cb: (cmd: HostCommand) => void): () => void;
  on(ev: "resume", cb: () => void): () => void;
  on(ev: "daemon", cb: (s: DaemonStatus) => void): () => void;
  on(ev: "window", cb: (s: WindowState) => void): () => void;
  /** `notify-settings`: what the shell has seen changed. */
  on(ev: "notify-permission", cb: (p: NotifyPermission) => void): () => void;
  /** `update`: the state now (on subscribing), then every change. Listening
   *  takes the restart over: while the window is in front (shown, not
   *  minimised, focused) the shell posts no "ready" notification, and the
   *  tray's and the menu's "Restart to Update" arrive here with `ask` instead
   *  of restarting. So listen only while the page does offer the restart, and
   *  call the returned `off` once it no longer does — the shell hears that. */
  on(ev: "update", cb: (u: HostUpdate) => void): () => void;
  /** The page is (true) / is no longer (false) drawing the window's lights;
   *  the shell hides / shows the system's own accordingly. */
  setWindowControls(drawn: boolean): void;
  windowControl(action: WindowAction): void;
  autostart: {
    get(): Promise<boolean>;
    set(on: boolean): Promise<void>;
  };
  /** `notify-settings` only — check the cap; an older shell has no such object. */
  notifications?: {
    permission(): Promise<NotifyPermission>;
    /** Show a test notification, in the shell's own words, and resolve with
     *  what the system said to it (`unknown`: it said nothing in time). */
    test(): Promise<NotifyPermission>;
    /** The system's notification settings for this app. */
    openSettings(): void;
  };
  /** `update` only — check the cap; an older shell has no such object. */
  update?: {
    state(): Promise<HostUpdate>;
    /** Quit and restart into the downloaded version. `false` (and nothing
     *  happens) unless one is `ready`. */
    install(): Promise<boolean>;
    /** Ask the update feed now (at most once a minute; sooner just answers
     *  with the state) and resolve once it has answered. */
    check(): Promise<HostUpdate>;
  };
  /** Run bots on this computer. `enable` / `disable` ask the person first in a
   *  native dialog the page cannot answer. */
  daemon: {
    status(): Promise<DaemonStatus>;
    enable(username: string): Promise<DaemonEnableResult>;
    disable(username: string): Promise<DaemonDisableResult>;
    /** `bot-restart` only — check the cap; an older shell has no such method.
     *  Restart the bot `name` (as in `bots`); it counts once its new process
     *  is read back running. Interrupts the replies it is writing, which the
     *  new process picks up — no dialog first. `username`: who the page is
     *  signed in as — the bot has to be theirs (`not_yours`); an older shell
     *  ignores it. */
    restart?(name: string, username?: string): Promise<BotRestartResult>;
    /** `mafold-relogin` only. Sign `username` in again — someone signed in
     *  here whose login Mafold refused. Answers with a device code to approve
     *  as that person, like `enable`; the rest goes on as `task` step
     *  `relogin` (an error there, else `task: null` once read back). */
    relogin?(username: string): Promise<DaemonEnableResult>;
    /** `runtime-login` only. Start signing this computer's `runtime` in
     *  (`claude-code`): resolves once its sign-in page is out. */
    runtimeLogin?(runtime: string): Promise<RuntimeLoginStart>;
    /** `runtime-login` only. The Authentication Code the person copied from
     *  the sign-in page; resolves once signed in and read back. */
    runtimeLoginCode?(code: string): Promise<RuntimeLoginResult>;
    /** `runtime-login` only. Stop a sign-in that waits for its code. */
    runtimeLoginCancel?(): Promise<void>;
    /** `logs` only. The last `lines` (1–500) of `bot`'s log — one of the
     *  person's bots, as in `bots` — or, `null`, the supervisor's.
     *  `username`: who the page is signed in as (`not_yours`). */
    logs?(username: string, bot: string | null, lines: number): Promise<LogTail>;
    /** `logs` only. The last `lines`, then whatever gets written, to `cb` as
     *  frames until the returned function is called. One follow at a time: a
     *  newer one ends this (`replaced`). It also ends by itself when the
     *  window closes or the page goes (`closed`). */
    followLogs?(username: string, bot: string | null, lines: number, cb: (f: LogFrame) => void): () => void;
    /** `logs` only. Write a diagnostics file (mafold-cli's `diagnose`: this
     *  computer's status, its bots' settings and the end of each log, masked)
     *  where the person picks in the system's save dialog. */
    diagnose?(): Promise<DiagnoseResult>;
    /** `cli-update` only. Ask the release feed what is on offer now; installs nothing. */
    checkUpdate?(): Promise<CliUpdateResult>;
    /** `cli-update` only. Install the newest release (checksummed, the old one
     *  kept for a rollback). Resolves once the new version reads back on disk
     *  and — when the supervisor here takes restart requests — once it runs
     *  it, after the replies it is writing (up to 5 minutes). Meanwhile
     *  another install or rollback is `busy`. */
    updateCli?(): Promise<CliInstallResult>;
    /** `cli-update` only. Turn this computer's automatic updates on or off —
     *  a setting the supervisor reads; nothing is restarted. */
    setAutoUpdate?(on: boolean): Promise<CliUpdateResult>;
    /** `cli-update` only. Follow `stable` or `dev` releases from now on, and
     *  check what that channel offers; installs nothing. */
    setChannel?(channel: "stable" | "dev"): Promise<CliUpdateResult>;
    /** `cli-update` only. Is there an earlier version here to go back to that
     *  would stay? Offer `rollback` only when it says so. */
    rollbackCheck?(): Promise<CliRollbackCheck>;
    /** `cli-update` only. Go back to the earlier version, after asking the
     *  person in a native dialog; the version left is skipped until a newer
     *  one is out. Only the versions the dialog named (`changed` otherwise).
     *  Resolves like `updateCli`. */
    rollback?(): Promise<CliInstallResult>;
    /** `adopt` only. Could this computer be handed to Mafold, and what would
     *  that restart? Offer `adopt` only when it says `adoptable`. */
    adoptCheck?(): Promise<AdoptCheck>;
    /** `adopt` only. Hand this computer's bots to Mafold, after asking the
     *  person in a native dialog that names them: it waits for the replies
     *  being written (up to 5 minutes), restarts each bot once, and the
     *  service runs the shell's mafold from then on. Only what the dialog
     *  named (`changed` otherwise). Resolves once read back — minutes, while
     *  replies finish; meanwhile the shell is `busy`. */
    adopt?(): Promise<AdoptResult>;
  };
}

/** Prefix on an OAuth `state` started from the desktop shell. */
export const DESKTOP_STATE_PREFIX = "dsk_";

export const isDesktopState = (state: string): boolean => state.startsWith(DESKTOP_STATE_PREFIX);

/** The URL scheme the shell registers with the OS. */
export const DEEP_LINK_SCHEME = "mafold";

/** IPC channel names. Renderer → main unless noted. */
export const IPC = {
  setUnread: "mafold-host:set-unread",
  notify: "mafold-host:notify",
  notifyPermission: "mafold-host:notify-permission",
  notifyTest: "mafold-host:notify-test",
  notifySettings: "mafold-host:notify-settings",
  openExternal: "mafold-host:open-external",
  oauth: "mafold-host:oauth",
  setLocale: "mafold-host:set-locale",
  setAppearance: "mafold-host:set-appearance",
  autostartGet: "mafold-host:autostart-get",
  autostartSet: "mafold-host:autostart-set",
  /** The page started listening for an event name — a deep link that launched
   *  the app waits for this rather than arriving before anyone hears it. */
  subscribe: "mafold-host:subscribe",
  /** The page's last listener for an event name went away (the `off` its `on`
   *  returned) — the shell no longer counts on it: `update`'s restart from the
   *  tray and the menu goes back to restarting at once. */
  unsubscribe: "mafold-host:unsubscribe",
  daemonStatus: "mafold-host:daemon-status",
  daemonEnable: "mafold-host:daemon-enable",
  daemonDisable: "mafold-host:daemon-disable",
  daemonRestart: "mafold-host:daemon-restart",
  daemonRelogin: "mafold-host:daemon-relogin",
  runtimeLogin: "mafold-host:runtime-login",
  runtimeLoginCode: "mafold-host:runtime-login-code",
  runtimeLoginCancel: "mafold-host:runtime-login-cancel",
  daemonLogs: "mafold-host:daemon-logs",
  /** Start a follow; its frames come as the `logs` event, `{ id, ...LogFrame }`. */
  logsFollow: "mafold-host:logs-follow",
  logsStop: "mafold-host:logs-stop",
  diagnose: "mafold-host:diagnose",
  cliCheck: "mafold-host:cli-check",
  cliInstall: "mafold-host:cli-install",
  cliAutoUpdate: "mafold-host:cli-auto-update",
  cliChannel: "mafold-host:cli-channel",
  cliRollbackCheck: "mafold-host:cli-rollback-check",
  cliRollback: "mafold-host:cli-rollback",
  adoptCheck: "mafold-host:adopt-check",
  adopt: "mafold-host:adopt",
  setWindowControls: "mafold-host:set-window-controls",
  windowControl: "mafold-host:window-control",
  updateState: "mafold-host:update-state",
  updateInstall: "mafold-host:update-install",
  updateCheck: "mafold-host:update-check",
  /** main → renderer */
  event: "mafold-host:event",
} as const;

/** The envelope of a main → renderer event. */
export interface HostEventEnvelope {
  name: HostEventName;
  payload?: string;
}

/** The longest hash a deep link may carry into the page. */
export const MAX_DEEP_LINK_HASH = 512;
