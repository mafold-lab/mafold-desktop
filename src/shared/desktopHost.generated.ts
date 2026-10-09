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
  "notify",
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
  // `window-controls` (macOS) — the window has no title bar; the page draws the
  // close / minimise / zoom lights itself (`setWindowControls`, `windowControl`)
  // where mafold-mac drew them, and hears `on("window")` for full screen.
  "window-controls",
  // `window-arrange` (macOS) — the green light does what the system's does:
  // full screen on a click, zoom with ⌥, and the move-and-resize menu on hover
  // (`windowControl` "fullscreen" / "fill" / "center" / "tile-left" / "tile-right").
  // Without it the page's green light is the original zoom and nothing else.
  "window-arrange",
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

export type HostEventName = "navigate" | "command" | "resume" | "daemon" | "window";

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
 * shell). `foreign`: the supervisor's service is registered to a DIFFERENT
 * mafold binary than the one the shell manages (installed by hand, a dev
 * build) — the shell then only looks, never starts or stops it, because
 * `mafold up` from another binary would take the service over.
 */
export interface DaemonStatus {
  /** `outdated`: a mafold too old to report its status to the shell (before
   *  `status --json`); `enable` updates it first. */
  cli: { installed: boolean; version?: string; outdated?: boolean };
  supervisor: "running" | "stopped" | "absent" | "foreign";
  /** People signed in on this computer (the supervisor serves all of them). */
  accounts: string[];
  bots: { name: string; harness: string; running: boolean; busy: boolean }[];
  harnesses: { id: string; available: boolean; version?: string }[];
  /** "cached": this computer holds the connections key; "device": not yet. */
  vault: "cached" | "device" | "none";
  /** What the shell is doing about it right now. */
  task: null | { step: "install" | "login" | "unlock" | "start" | "stop"; error?: string };
}

export type DaemonEnableResult =
  /** Approve this device code as the signed-in person (`auth/device/approve`). */
  | { userCode: string }
  /** Already signed in here; the shell carries on by itself. */
  | { ready: true }
  | { error: string };

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
  /** The page is (true) / is no longer (false) drawing the window's lights;
   *  the shell hides / shows the system's own accordingly. */
  setWindowControls(drawn: boolean): void;
  windowControl(action: WindowAction): void;
  autostart: {
    get(): Promise<boolean>;
    set(on: boolean): Promise<void>;
  };
  /** Run bots on this computer. `enable` / `disable` ask the person first in a
   *  native dialog the page cannot answer. */
  daemon: {
    status(): Promise<DaemonStatus>;
    enable(username: string): Promise<DaemonEnableResult>;
    disable(username: string): Promise<{ ok: boolean; error?: string }>;
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
  openExternal: "mafold-host:open-external",
  oauth: "mafold-host:oauth",
  setLocale: "mafold-host:set-locale",
  setAppearance: "mafold-host:set-appearance",
  autostartGet: "mafold-host:autostart-get",
  autostartSet: "mafold-host:autostart-set",
  /** The page started listening for an event name — a deep link that launched
   *  the app waits for this rather than arriving before anyone hears it. */
  subscribe: "mafold-host:subscribe",
  daemonStatus: "mafold-host:daemon-status",
  daemonEnable: "mafold-host:daemon-enable",
  daemonDisable: "mafold-host:daemon-disable",
  setWindowControls: "mafold-host:set-window-controls",
  windowControl: "mafold-host:window-control",
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
