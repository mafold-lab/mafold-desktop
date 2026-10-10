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
  type Appearance,
  type DaemonEnableResult,
  type DaemonStatus,
  type HostCap,
  type HostCommand,
  type HostEventEnvelope,
  type HostEventName,
  type HostNotification,
  type HostOs,
  type MafoldHost,
  type NotifyPermission,
  type OAuthResult,
  type UnreadSummary,
  type WindowAction,
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
    return () => {
      set?.delete(cb);
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
      return () => {};
    }) as MafoldHost["on"],
    setWindowControls: (drawn: boolean) => ipcRenderer.send(IPC.setWindowControls, drawn === true),
    windowControl: (action: WindowAction) => ipcRenderer.send(IPC.windowControl, action),
    daemon: {
      status: (): Promise<DaemonStatus> => ipcRenderer.invoke(IPC.daemonStatus),
      enable: (username: string): Promise<DaemonEnableResult> => ipcRenderer.invoke(IPC.daemonEnable, username),
      disable: (username: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.daemonDisable, username),
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
  };

  contextBridge.exposeInMainWorld("mafoldHost", host);
}
