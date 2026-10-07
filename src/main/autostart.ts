// Open at login. Only a packaged app registers itself: an unpackaged one
// (`npm start`, e2e) would register the bare Electron binary as a login item
// on the developer's own machine.

import { app } from "electron";

export interface Autostart {
  get(): boolean;
  set(on: boolean): void;
}

export const HIDDEN_ARG = "--hidden";

export function makeAutostart(os: "macos" | "windows" | "linux"): Autostart {
  return {
    get: () => (app.isPackaged ? app.getLoginItemSettings().openAtLogin : false),
    set: (on) => {
      if (!app.isPackaged) return;
      app.setLoginItemSettings({ openAtLogin: on, args: os === "windows" ? [HIDDEN_ARG] : undefined });
    },
  };
}

/** Launched by the login item: start in the tray rather than in the person's face. */
export function launchedAtLogin(os: "macos" | "windows" | "linux"): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true;
  if (os !== "macos" || !app.isPackaged) return false;
  return (app.getLoginItemSettings() as { wasOpenedAtLogin?: boolean }).wasOpenedAtLogin === true;
}
