// OS notifications on behalf of the page. The page decides WHETHER (focus,
// mute, notification preferences — mafold-web lib/webpush.ts); the shell only
// shows it and, on click, brings the window forward at that conversation.
//
// One notification per conversation at a time, like the web's `tag`: a newer
// message replaces the older banner instead of stacking under it.
//
// Whether the system lets the app show them at all (System Settings ▸
// Notifications on macOS, Settings ▸ Notifications on Windows) has no call the
// shell can make — Electron has none, and macOS's own (UNUserNotificationCenter
// getNotificationSettings) would take a native module. So the shell keeps what
// it has SEEN: a notification the system took is `allowed`, one it refused
// (`failed`) is `blocked`. Kept across launches, so a blocked app says so in
// Settings straight away instead of after the next message nobody saw.
// (Windows takes a toast even when the person switched the app off, so there
// only a real failure reads as `blocked`.)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Notification } from "electron";

import { APP_ID } from "./config";
import { log } from "./log";
import { notifySettingsUrl, parsePermission } from "./notifyPermission";
import { resourcePath } from "./paths";
import type { Shell } from "./shell";
import type { HostNotification, NotifyPermission } from "../shared/desktopHost.generated";

type Os = "macos" | "windows" | "linux";

const live = new Map<string, Notification>();
let shownCount = 0;
let permission: NotifyPermission = "unknown";
let permissionFile: string | null = null;

/** The test notification's slot in `live` — one at a time, like a conversation's. */
const TEST_KEY = "test";
/** How long a test waits for the system to take or refuse it. */
const TEST_TIMEOUT_MS = 5_000;

/**
 * At start-up: read what was seen last time, and — on macOS — create the
 * notification presenter now. Creating it is what asks the person, once ever,
 * whether Mafold may notify them; left to the first message, the question
 * arrives with it and that message's banner is refused while it waits.
 */
export function initNotifications(shell: Shell, dir: string, os: Os): void {
  permissionFile = join(dir, "notify-permission.json");
  let text: string | null = null;
  try {
    text = readFileSync(permissionFile, "utf8");
  } catch {
    /* first run */
  }
  permission = parsePermission(text);
  if (os === "macos" && !shell.cfg.test) Notification.isSupported();
}

export const notifyPermission = (): NotifyPermission => permission;

/** The system took / refused a notification, or the shell lost track (exported for e2e). */
export function saw(shell: Shell, p: NotifyPermission): void {
  if (p === permission) return;
  permission = p;
  if (permissionFile) {
    try {
      writeFileSync(permissionFile, JSON.stringify({ permission: p }));
    } catch (e) {
      log("could not save notification permission:", e);
    }
  }
  shell.emit("notify-permission", p);
}

function present(
  shell: Shell,
  key: string,
  note: Notification,
  onClick: () => void,
  settle?: (p: NotifyPermission) => void,
): void {
  live.get(key)?.close();
  note.on("click", () => {
    live.delete(key);
    onClick();
  });
  note.on("close", () => {
    if (live.get(key) === note) live.delete(key);
  });
  note.on("show", () => {
    saw(shell, "allowed");
    settle?.("allowed");
  });
  note.on("failed", (_e, error) => {
    log("notification refused:", error);
    if (live.get(key) === note) live.delete(key);
    saw(shell, "blocked");
    settle?.("blocked");
  });
  // Held until closed: on macOS a notification whose object is collected is
  // taken back out of Notification Center.
  live.set(key, note);
  note.show();
}

export function showNotification(shell: Shell, n: HostNotification, os: Os): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({
    title: n.title,
    body: n.body,
    silent: n.silent,
    icon: os === "macos" ? undefined : resourcePath("icon-256.png"),
  });
  present(shell, n.convId, note, () => {
    shell.showWindow();
    shell.emit("navigate", n.msgId ? `#${n.convId}/${n.msgId}` : `#${n.convId}`);
  });
  shownCount++;
  const w = shell.window;
  if (os === "windows" && w && !w.isDestroyed() && !w.isFocused()) w.flashFrame(true);
}

/** A notification in the shell's own words, to find out whether the system shows them. */
export function testNotification(shell: Shell, os: Os): Promise<NotifyPermission> {
  if (!Notification.isSupported()) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (p: NotifyPermission) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(p);
    };
    const timer = setTimeout(() => settle("unknown"), TEST_TIMEOUT_MS);
    const note = new Notification({
      title: shell.strings.t("desktop.notify.test.title"),
      body: shell.strings.t("desktop.notify.test.body"),
      icon: os === "macos" ? undefined : resourcePath("icon-256.png"),
    });
    present(shell, TEST_KEY, note, () => shell.showWindow(), settle);
  });
}

/** Open the system's notification settings for Mafold. Whatever the person
 *  does there, the shell can no longer vouch for what it saw before. */
export function openNotifySettings(shell: Shell, os: Os, systemVersion: string): void {
  const url = notifySettingsUrl(os, systemVersion, APP_ID);
  if (!url) return;
  if (shell.openSystemSettings(url)) saw(shell, "unknown");
}

/** How many notifications have been shown, for tests. */
export const notificationsShown = (): number => shownCount;
