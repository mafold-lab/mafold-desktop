// Wiring the pure rules in policy.ts to Electron: what every web contents may
// navigate to, open, attach and download, and which permissions it gets.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  session as electronSession,
  shell as electronShell,
  webContents as electronWebContents,
  type Session,
  type WebContents,
} from "electron";

import { RateLimit, uniqueName } from "./limits";
import { log, redact } from "./log";
import { decideNavigation, decideWindowOpen, permissionAllowed, shellUserAgent } from "./policy";
import type { Shell } from "./shell";
import { accountChoice, accountLabel, KEYCHAIN_ACCESS_GROUP } from "./webauthn";

export const PARTITION = "persist:mafold";

const popupLimit = new RateLimit(1500);

/** Size of the child window a third-party popup (a mini-app's own sign-in) gets. */
const CHILD = { width: 520, height: 720 };

/** Every web contents the app ever creates — main window, child popups. */
export function guardAllContents(shell: Shell): void {
  app.on("web-contents-created", (_e, contents) => {
    // No <webview> anywhere: the app never uses one, so any attempt is hostile.
    contents.on("will-attach-webview", (e) => e.preventDefault());

    contents.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details.url, details.referrer?.url ?? "", shell.cfg);
      if (decision === "deny") return { action: "deny" };
      if (!popupLimit.allow("popup", Date.now())) {
        log("rate-limited popup:", redact(details.url));
        return { action: "deny" };
      }
      if (decision === "external") {
        shell.openExternal(details.url, "window-open");
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          ...CHILD,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: PARTITION },
        },
      };
    });
  });
}

/**
 * Turn on the Touch ID passkey authenticator (macOS; see webauthn.ts). Must run
 * after `ready` and before the first page asks: until it does, the page is told
 * there is no platform authenticator. The prompt reason is the build's own
 * string, like every security prompt here — the page doesn't get to word it.
 * macOS frames it as `"Mafold" is trying to <reason>`.
 */
export function enablePasskeys(shell: Shell, os: string): void {
  if (os !== "macos") return;
  try {
    app.configureWebAuthn({
      touchID: { keychainAccessGroup: KEYCHAIN_ACCESS_GROUP, promptReason: shell.strings.frozen("desktop.passkey.reason") },
    });
  } catch (err) {
    log("passkeys: configureWebAuthn failed:", String(err));
  }
}

/** The main window's top-level navigations. Child windows are third-party
 *  pages and navigate as they please (their own window-open rule still holds). */
export function guardMainNavigation(contents: WebContents, shell: Shell, offlineUrl: string): void {
  const handle = (e: Electron.Event, url: string) => {
    // The offline page is the one local document the window may show.
    if (url.split(/[?#]/)[0] === offlineUrl) return;
    switch (decideNavigation(url, shell.cfg)) {
      case "allow":
        return;
      case "download":
        e.preventDefault();
        contents.downloadURL(url);
        return;
      case "external":
        e.preventDefault();
        shell.openExternal(url, "navigate");
        return;
      default:
        e.preventDefault();
        log("refused navigation:", redact(url));
    }
  };
  contents.on("will-navigate", (e) => handle(e, e.url));
  contents.on("will-redirect", (e) => {
    if (e.isMainFrame) handle(e, e.url);
  });
}

export function guardSession(shell: Shell): Session {
  const ses = electronSession.fromPartition(PARTITION);
  ses.setUserAgent(shellUserAgent(ses.getUserAgent(), shell.version));
  app.userAgentFallback = shellUserAgent(app.userAgentFallback, shell.version);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details as { requestingUrl?: string; isMainFrame?: boolean; mediaTypes?: string[]; externalURL?: string };
    const ok = permissionAllowed(
      {
        permission,
        requestingOrigin: d.requestingUrl ?? wc.getURL(),
        isMainFrame: d.isMainFrame ?? false,
        mediaTypes: d.mediaTypes,
        externalURL: d.externalURL,
      },
      shell.cfg,
    );
    if (!ok) log("denied permission:", permission);
    callback(ok);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const d = details as { isMainFrame?: boolean; mediaType?: string };
    return permissionAllowed(
      {
        permission,
        requestingOrigin,
        isMainFrame: d.isMainFrame ?? false,
        mediaTypes: d.mediaType && d.mediaType !== "unknown" ? [d.mediaType] : permission === "media" ? [] : undefined,
      },
      shell.cfg,
    );
  });

  // A sign-in that matches passkeys of more than one account (webauthn.ts).
  // Electron keeps the request open until `callback` runs, so it runs exactly
  // once whatever happens — a closed window, a dialog that throws.
  ses.on("select-webauthn-account", (_e, details, callback) => {
    const choice = accountChoice(details.accounts);
    if ("pick" in choice) return callback(choice.pick);
    if ("cancel" in choice) return callback();
    const f = (k: string, vars?: Record<string, string>) => shell.strings.frozen(k, vars);
    const owner = details.frame ? electronWebContents.fromFrame(details.frame) : undefined;
    const win = (owner && BrowserWindow.fromWebContents(owner)) || shell.window;
    const options = {
      type: "question" as const,
      message: f("desktop.passkey.pick.title"),
      detail: f("desktop.passkey.pick.detail", { site: details.relyingPartyId }),
      buttons: [...choice.ask.map(accountLabel), f("desktop.passkey.pick.cancel")],
      cancelId: choice.ask.length,
      noLink: true,
    };
    let picked: string | undefined;
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
      .then((r) => {
        picked = choice.ask[r.response]?.credentialId;
      })
      .catch((err: unknown) => log("passkey account picker failed:", String(err)))
      .finally(() => callback(picked));
  });

  ses.on("will-download", (_e, item) => {
    const dir = shell.cfg.test?.downloads ?? app.getPath("downloads");
    const name = uniqueName(item.getFilename(), (n) => existsSync(join(dir, n)));
    const path = join(dir, name);
    item.setSavePath(path);
    item.once("done", (_ev, state) => {
      if (state !== "completed") {
        log("download", state);
        return;
      }
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: shell.strings.t("desktop.download.done", { name }), body: shell.strings.t("desktop.download.show"), silent: true });
      n.on("click", () => electronShell.showItemInFolder(path));
      n.show();
    });
  });

  return ses;
}
