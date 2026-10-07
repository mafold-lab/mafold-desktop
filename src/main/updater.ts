// Updates of the shell itself. The web app updates by being the live site; this
// is only for the shell (Electron, the bridge, menus). electron-updater reads a
// generic feed on our CDN (`latest-mac.yml` / `latest.yml`), downloads in the
// background, and the person restarts when it suits them — from the tray or the
// app menu, or simply on their next quit.
//
// Windows builds are not code-signed (owner, 2026-10-05), so there is no
// publisher to verify: integrity rests on the sha512 in `latest.yml` served
// over HTTPS, and write access to the feed's prefix belongs to the release CI
// alone.

import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";

import { log } from "./log";
import type { Shell } from "./shell";

const EVERY_MS = 4 * 60 * 60_000;

let installer: (() => void) | null = null;

export function installUpdate(): void {
  installer?.();
}

export function initUpdater(shell: Shell): void {
  if (!shell.cfg.updateFeed || !app.isPackaged) return;
  autoUpdater.setFeedURL({ provider: "generic", url: shell.cfg.updateFeed });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log("updater:", m),
    warn: (m: unknown) => log("updater warn:", m),
    error: (m: unknown) => log("updater error:", m),
    debug: () => {},
  };
  autoUpdater.on("update-downloaded", (info) => {
    log("update ready:", info.version);
    shell.updateReady = true;
    shell.changed();
    if (Notification.isSupported()) {
      const n = new Notification({ title: "Mafold", body: shell.strings.t("desktop.update.ready"), silent: true });
      n.on("click", () => installUpdate());
      n.show();
    }
  });
  installer = () => {
    shell.quitting = true;
    autoUpdater.quitAndInstall();
  };
  const check = () => void autoUpdater.checkForUpdates().catch((e) => log("update check failed:", e));
  setTimeout(check, 15_000).unref();
  setInterval(check, EVERY_MS).unref();
}
