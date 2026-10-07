// OS notifications on behalf of the page. The page decides WHETHER (focus,
// mute, notification preferences — mafold-web lib/webpush.ts); the shell only
// shows it and, on click, brings the window forward at that conversation.
//
// One notification per conversation at a time, like the web's `tag`: a newer
// message replaces the older banner instead of stacking under it.

import { Notification } from "electron";

import { resourcePath } from "./paths";
import type { Shell } from "./shell";
import type { HostNotification } from "../shared/desktopHost.generated";

const live = new Map<string, Notification>();
let shownCount = 0;

export function showNotification(shell: Shell, n: HostNotification, os: "macos" | "windows" | "linux"): void {
  if (!Notification.isSupported()) return;
  live.get(n.convId)?.close();
  const note = new Notification({
    title: n.title,
    body: n.body,
    silent: n.silent,
    icon: os === "macos" ? undefined : resourcePath("icon-256.png"),
  });
  note.on("click", () => {
    live.delete(n.convId);
    shell.showWindow();
    shell.emit("navigate", n.msgId ? `#${n.convId}/${n.msgId}` : `#${n.convId}`);
  });
  note.on("close", () => {
    if (live.get(n.convId) === note) live.delete(n.convId);
  });
  live.set(n.convId, note);
  note.show();
  shownCount++;
  const w = shell.window;
  if (os === "windows" && w && !w.isDestroyed() && !w.isFocused()) w.flashFrame(true);
}

/** How many notifications have been shown, for tests. */
export const notificationsShown = (): number => shownCount;
