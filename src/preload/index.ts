// The page-side half of `window.mafoldHost`.
//
// Exposed ONLY when this document is the web origin. The preload runs in the
// main window's top frame (and in child popups, which inherit it): a popup that
// shows a third-party page, the offline page and anything else get nothing.
// The main process checks the caller again on every message (bridge.ts) — this
// is the first lock, not the only one.
//
// Sandboxed preloads cannot require local files; scripts/build.mjs bundles
// this with the shared contract into one file.

import { contextBridge, ipcRenderer } from "electron";

import {
  HOST_CAPS,
  IPC,
  type AdoptCheck,
  type AdoptResult,
  type Appearance,
  type BotRestartResult,
  type CliInstallResult,
  type CliRollbackCheck,
  type CliUpdateResult,
  type DaemonDisableResult,
  type DaemonEnableResult,
  type DaemonStatus,
  type DiagnoseResult,
  type HostCap,
  type HostCommand,
  type HostEventEnvelope,
  type HostEventName,
  type HostNotification,
  type HostOs,
  type HostUpdate,
  type LogError,
  type LogFrame,
  type LogTail,
  type MafoldHost,
  type NotifyPermission,
  type OAuthResult,
  type RuntimeLoginResult,
  type RuntimeLoginStart,
  type UnreadSummary,
  type WindowAction,
  type WindowLayout,
  type WindowState,
} from "../shared/desktopHost.generated";

const arg = (name: string): string => {
  const prefix = `--mafold-${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? "";
};

const webOrigin = arg("web-origin");

if (webOrigin && window.location.origin === webOrigin) {
  const known = new Set<string>(HOST_CAPS);
  const caps = Object.freeze(arg("caps").split(",").filter((c) => known.has(c)) as HostCap[]);
  const listeners = new Map<HostEventName, Set<(payload?: string) => void>>();
  /** `followLogs` names each follow this page starts (the shell tags its frames). */
  let follows = 0;

  ipcRenderer.on(IPC.event, (_e, env: HostEventEnvelope) => {
    const set = listeners.get(env?.name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(env.payload);
      } catch (err) {
        console.error("[mafoldHost]", err);
      }
    }
  });

  const subscribe = (name: HostEventName, cb: (payload?: string) => void): (() => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    const first = set.size === 0;
    set.add(cb);
    if (first) ipcRenderer.send(IPC.subscribe, name);
    // The shell counts on a page that listens (the update's restart goes to
    // it), so it hears when the last listener goes too; listening again later
    // is a first one again.
    return () => {
      if (set?.delete(cb) && set.size === 0) ipcRenderer.send(IPC.unsubscribe, name);
    };
  };

  const host: MafoldHost = {
    kind: "desktop",
    version: arg("version"),
    os: (arg("os") === "windows" ? "windows" : "macos") as HostOs,
    caps,
    setUnread: (u: UnreadSummary) => ipcRenderer.send(IPC.setUnread, u),
    notify: (n: HostNotification) => ipcRenderer.send(IPC.notify, n),
    openExternal: (url: string) => ipcRenderer.send(IPC.openExternal, url),
    oauth: (authorizeUrl: string, state: string): Promise<OAuthResult> => ipcRenderer.invoke(IPC.oauth, authorizeUrl, state),
    setLocale: (lang: string, strings: Record<string, string>) => ipcRenderer.send(IPC.setLocale, lang, strings),
    setAppearance: (mode: Appearance) => ipcRenderer.send(IPC.setAppearance, mode),
    on: ((name: HostEventName, cb: (payload?: string) => void) => {
      if (name === "navigate") return subscribe(name, (p) => typeof p === "string" && cb(p));
      if (name === "command") return subscribe(name, (p) => typeof p === "string" && (cb as (c: HostCommand) => void)(p as HostCommand));
      if (name === "resume") return subscribe(name, () => (cb as () => void)());
      if (name === "daemon") {
        return subscribe(name, (p) => {
          if (typeof p !== "string") return;
          try {
            (cb as unknown as (s: DaemonStatus) => void)(JSON.parse(p) as DaemonStatus);
          } catch {
            /* a malformed frame is dropped */
          }
        });
      }
      if (name === "window") {
        return subscribe(name, (p) => (cb as unknown as (s: WindowState) => void)({ fullscreen: p === "fullscreen" }));
      }
      if (name === "notify-permission") {
        return subscribe(name, (p) => {
          if (p === "allowed" || p === "blocked" || p === "unknown") (cb as unknown as (s: NotifyPermission) => void)(p);
        });
      }
      if (name === "update") {
        const deliver = cb as unknown as (u: HostUpdate) => void;
        // The shell answers a subscription with the state now (updater.ts), but
        // only the page's first is sent to it: a later listener asks for the
        // state itself, and only it hears the answer — unless an event reached
        // it first, which is at least as new.
        const later = (listeners.get(name)?.size ?? 0) > 0;
        let live = true;
        let heard = false;
        const off = subscribe(name, (p) => {
          if (typeof p !== "string") return;
          let u: HostUpdate;
          try {
            u = JSON.parse(p) as HostUpdate;
          } catch {
            return; // a malformed frame is dropped
          }
          heard = true;
          deliver(u);
        });
        if (later) {
          ipcRenderer
            .invoke(IPC.updateState)
            .then((u: HostUpdate | null) => {
              if (live && !heard && u) deliver(u);
            })
            .catch((err) => console.error("[mafoldHost]", err));
        }
        return () => {
          live = false;
          off();
        };
      }
      return () => {};
    }) as MafoldHost["on"],
    setWindowControls: (drawn: boolean) => ipcRenderer.send(IPC.setWindowControls, drawn === true),
    windowControl: (action: WindowAction) => ipcRenderer.send(IPC.windowControl, action),
    setWindowLayout: (layout: WindowLayout) => ipcRenderer.send(IPC.setWindowLayout, layout),
    daemon: {
      status: (): Promise<DaemonStatus> => ipcRenderer.invoke(IPC.daemonStatus),
      enable: (username: string): Promise<DaemonEnableResult> => ipcRenderer.invoke(IPC.daemonEnable, username),
      disable: (username: string): Promise<DaemonDisableResult> => ipcRenderer.invoke(IPC.daemonDisable, username),
      restart: (name: string, username?: string): Promise<BotRestartResult> =>
        username === undefined ? ipcRenderer.invoke(IPC.daemonRestart, name) : ipcRenderer.invoke(IPC.daemonRestart, name, username),
      relogin: (username: string): Promise<DaemonEnableResult> => ipcRenderer.invoke(IPC.daemonRelogin, username),
      runtimeLogin: (runtime: string): Promise<RuntimeLoginStart> => ipcRenderer.invoke(IPC.runtimeLogin, runtime),
      runtimeLoginCode: (code: string): Promise<RuntimeLoginResult> => ipcRenderer.invoke(IPC.runtimeLoginCode, code),
      runtimeLoginCancel: async (): Promise<void> => {
        await ipcRenderer.invoke(IPC.runtimeLoginCancel);
      },
      logs: (username: string, bot: string | null, lines: number): Promise<LogTail> => ipcRenderer.invoke(IPC.daemonLogs, username, bot, lines),
      followLogs: (username: string, bot: string | null, lines: number, cb: (f: LogFrame) => void): (() => void) => {
        // Listening before asking: the first frame can't arrive unheard.
        const id = ++follows;
        let live = true;
        const done = (f: LogFrame) => {
          live = false;
          off();
          cb(f);
        };
        const off = subscribe("logs", (p) => {
          if (!live || typeof p !== "string") return;
          let f: { id?: unknown } & LogFrame;
          try {
            f = JSON.parse(p) as { id?: unknown } & LogFrame;
          } catch {
            return; // a malformed frame is dropped
          }
          if (f?.id !== id) return;
          const { id: _id, ...frame } = f;
          if (frame.end) done(frame);
          else cb(frame);
        });
        ipcRenderer
          .invoke(IPC.logsFollow, id, username, bot, lines)
          .then((r: { ok: boolean; error?: LogError }) => {
            if (live && !r?.ok) done({ end: r?.error ?? "failed" });
          })
          .catch(() => {
            if (live) done({ end: "failed" });
          });
        return () => {
          if (!live) return;
          live = false;
          off();
          ipcRenderer.send(IPC.logsStop, id);
        };
      },
      diagnose: (): Promise<DiagnoseResult> => ipcRenderer.invoke(IPC.diagnose),
      checkUpdate: (): Promise<CliUpdateResult> => ipcRenderer.invoke(IPC.cliCheck),
      updateCli: (): Promise<CliInstallResult> => ipcRenderer.invoke(IPC.cliInstall),
      setAutoUpdate: (on: boolean): Promise<CliUpdateResult> => ipcRenderer.invoke(IPC.cliAutoUpdate, on),
      setChannel: (channel: "stable" | "dev"): Promise<CliUpdateResult> => ipcRenderer.invoke(IPC.cliChannel, channel),
      rollbackCheck: (): Promise<CliRollbackCheck> => ipcRenderer.invoke(IPC.cliRollbackCheck),
      rollback: (): Promise<CliInstallResult> => ipcRenderer.invoke(IPC.cliRollback),
      adoptCheck: (): Promise<AdoptCheck> => ipcRenderer.invoke(IPC.adoptCheck),
      adopt: (): Promise<AdoptResult> => ipcRenderer.invoke(IPC.adopt),
    },
    autostart: {
      get: (): Promise<boolean> => ipcRenderer.invoke(IPC.autostartGet),
      set: async (on: boolean): Promise<void> => {
        await ipcRenderer.invoke(IPC.autostartSet, on);
      },
    },
    notifications: {
      permission: (): Promise<NotifyPermission> => ipcRenderer.invoke(IPC.notifyPermission),
      test: (): Promise<NotifyPermission> => ipcRenderer.invoke(IPC.notifyTest),
      openSettings: () => ipcRenderer.send(IPC.notifySettings),
    },
    update: {
      state: (): Promise<HostUpdate> => ipcRenderer.invoke(IPC.updateState),
      install: (): Promise<boolean> => ipcRenderer.invoke(IPC.updateInstall),
      check: (): Promise<HostUpdate> => ipcRenderer.invoke(IPC.updateCheck),
    },
  };

  contextBridge.exposeInMainWorld("mafoldHost", host);
}
