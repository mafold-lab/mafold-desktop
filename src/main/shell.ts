// The one object every part of the main process shares: configuration, the
// strings, the main window, what the page has subscribed to, and the unread
// summary the badge and tray draw. Kept in one place so the modules around it
// (window, tray, menu, bridge, …) don't import each other in circles.

import { appendFileSync } from "node:fs";
import { BrowserWindow, shell as electronShell } from "electron";

import type { ShellConfig } from "./config";
import type { Strings } from "./i18n";
import { RateLimit } from "./limits";
import { log, redact } from "./log";
import { PendingAuth } from "./oauth";
import { isExternalUrl } from "./policy";
import { IPC, type HostEventEnvelope, type HostEventName, type UnreadSummary } from "../shared/desktopHost.generated";

export class Shell {
  window: BrowserWindow | null = null;
  quitting = false;
  updateReady = false;
  unread: UnreadSummary = { total: 0, top: [] };
  readonly pending = new PendingAuth();
  private externalLimit = new RateLimit(1000);
  private subscribed = new Set<HostEventName>();
  private queuedNavigate: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    readonly cfg: ShellConfig,
    readonly strings: Strings,
    readonly version: string,
  ) {}

  /** Something the tray / menu / badge draw changed. */
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        log("change listener failed:", e);
      }
    }
  }

  showWindow(): void {
    const w = this.window;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  private subscribeHooks = new Set<(name: HostEventName) => void>();

  /** Run `fn` whenever the page starts listening to an event. */
  onSubscribe(fn: (name: HostEventName) => void): void {
    this.subscribeHooks.add(fn);
  }

  isSubscribed(name: HostEventName): boolean {
    return this.subscribed.has(name);
  }

  /** The page asked to hear `name`; deliver anything that was waiting for it. */
  subscribe(name: HostEventName): void {
    this.subscribed.add(name);
    for (const fn of this.subscribeHooks) fn(name);
    if (name === "navigate" && this.queuedNavigate) {
      const hash = this.queuedNavigate;
      this.queuedNavigate = null;
      this.send({ name: "navigate", payload: hash });
    }
  }

  /** A new document in the main window: its subscriptions start from nothing. */
  resetSubscriptions(): void {
    this.subscribed.clear();
  }

  /**
   * Tell the page. A `navigate` that arrives before the page listens (a deep
   * link that launched the app) is held — only the latest one, since a person
   * clicking two links wants the second. Commands and resumes are moments, not
   * state: if nobody listens they are dropped rather than replayed late.
   */
  emit(name: HostEventName, payload?: string): void {
    if (!this.subscribed.has(name)) {
      if (name === "navigate" && payload) this.queuedNavigate = payload;
      return;
    }
    this.send({ name, payload });
  }

  private send(env: HostEventEnvelope): void {
    const w = this.window;
    if (!w || w.isDestroyed()) return;
    w.webContents.send(IPC.event, env);
  }

  /** Open in the system's handler — http(s), mailto, tel only, at most once a
   *  second. Under e2e the URL is written down instead of opened. */
  openExternal(url: string, why: string): boolean {
    if (!isExternalUrl(url)) {
      log("refused external:", why, redact(url));
      return false;
    }
    if (!this.externalLimit.allow("external", Date.now())) {
      log("rate-limited external:", why);
      return false;
    }
    if (this.cfg.test?.externalLog) {
      appendFileSync(this.cfg.test.externalLog, `${why}\t${url}\n`);
      return true;
    }
    void electronShell.openExternal(url).catch((e) => log("openExternal failed:", e));
    return true;
  }

  /** Open one of the system's own settings panes — a URL the shell built
   *  (notify.ts), never one from the page. Same once-a-second limit; under e2e
   *  written down instead of opened. */
  openSystemSettings(url: string): boolean {
    if (!this.externalLimit.allow("settings", Date.now())) {
      log("rate-limited settings");
      return false;
    }
    if (this.cfg.test?.externalLog) {
      appendFileSync(this.cfg.test.externalLog, `settings\t${url}\n`);
      return true;
    }
    void electronShell.openExternal(url).catch((e) => log("open settings failed:", e));
    return true;
  }
}
