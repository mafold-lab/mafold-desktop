// Whether the system lets Mafold show notifications, as the shell can know it
// (notify.ts), and where the person changes it. Pure, so test/units.spec.ts
// covers it without Electron.

import type { NotifyPermission } from "../shared/desktopHost.generated";

/** What a saved permission file says; anything unreadable is `unknown`. */
export function parsePermission(text: string | null): NotifyPermission {
  try {
    const p = (JSON.parse(text ?? "") as { permission?: unknown } | null)?.permission;
    return p === "allowed" || p === "blocked" ? p : "unknown";
  } catch {
    return "unknown";
  }
}

/** The system's notification settings for the app `appId`, or null where
 *  there are none to open. */
export function notifySettingsUrl(os: "macos" | "windows" | "linux", systemVersion: string, appId: string): string | null {
  if (os === "windows") return "ms-settings:notifications";
  if (os !== "macos") return null;
  const id = encodeURIComponent(appId);
  // System Settings (macOS 13+) names the pane by its extension; the older
  // System Preferences by its preference pane.
  return Number.parseInt(systemVersion, 10) >= 13
    ? `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${id}`
    : `x-apple.systempreferences:com.apple.preference.notifications?id=${id}`;
}
