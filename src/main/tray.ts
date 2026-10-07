// The tray (Windows) / menu-bar item (macOS): what is unread, and a way back in
// — the same job mafold-mac's status item did. The dock / taskbar badge is
// drawn here too, from the same summary.

import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

import { resourcePath } from "./paths";
import { badgePng } from "./png";
import type { Shell } from "./shell";
import { installUpdate } from "./updater";

let tray: Tray | null = null;
let lastLabels: string[] = [];
// What was last handed to the system, so a refresh only touches what changed:
// every setter here makes AppKit / the taskbar redraw, unchanged or not.
const drawn = { menu: "", title: "", tooltip: "", badge: -1 };

export function createTray(shell: Shell, os: "macos" | "windows" | "linux"): Tray {
  const icon =
    os === "macos"
      ? (() => {
          const img = nativeImage.createFromPath(resourcePath("trayTemplate.png"));
          img.setTemplateImage(true);
          return img;
        })()
      : nativeImage.createFromPath(resourcePath("tray-win.png"));
  tray = new Tray(icon);
  tray.setToolTip("Mafold");
  // On Windows a left click is "open the app"; the menu is the right click.
  if (os !== "macos") tray.on("click", () => shell.showWindow());
  refreshTray(shell, os);
  return tray;
}

export function refreshTray(shell: Shell, os: "macos" | "windows" | "linux"): void {
  const { total, top } = shell.unread;
  const t = (k: string, v?: Record<string, string | number>) => shell.strings.t(k, v);

  const menuKey = JSON.stringify([top, shell.updateReady, shell.strings.language]);
  if (tray && menuKey !== drawn.menu) {
    drawn.menu = menuKey;
    const rows: MenuItemConstructorOptions[] = top.length
      ? top.map((u) => ({
          label: `${u.title}${u.count > 1 ? `  (${u.count})` : ""}`,
          sublabel: u.preview || undefined,
          click: () => {
            shell.showWindow();
            shell.emit("navigate", `#${u.convId}`);
          },
        }))
      : [{ label: t("desktop.tray.noUnread"), enabled: false }];
    const menu: MenuItemConstructorOptions[] = [
      ...rows,
      { type: "separator" },
      { label: t("desktop.tray.open"), click: () => shell.showWindow() },
      ...(shell.updateReady ? [{ label: t("desktop.update.restart"), click: () => installUpdate() }] : []),
      { type: "separator" },
      { label: t("desktop.tray.quit"), click: () => app.quit() },
    ];
    lastLabels = menu.filter((m) => m.type !== "separator").map((m) => String(m.label ?? ""));
    tray.setContextMenu(Menu.buildFromTemplate(menu));
  }
  if (tray) {
    const tooltip = total > 0 ? `Mafold — ${t("desktop.tray.unread", { count: total })}` : "Mafold";
    if (tooltip !== drawn.tooltip) tray.setToolTip((drawn.tooltip = tooltip));
    const title = total > 0 ? (total > 99 ? "99+" : String(total)) : "";
    if (os === "macos" && title !== drawn.title) tray.setTitle((drawn.title = title));
  }

  // The badge on the app icon.
  if (total === drawn.badge) return;
  drawn.badge = total;
  if (os === "windows") {
    const w = shell.window;
    if (w && !w.isDestroyed()) {
      const png = badgePng(total);
      w.setOverlayIcon(png ? nativeImage.createFromBuffer(png) : null, png ? t("desktop.tray.unread", { count: total }) : "");
    }
  } else {
    app.setBadgeCount(Math.max(0, Math.min(total, 9999)));
  }
}

/** The tray menu's labels as last built, for tests. */
export const trayLabels = (): string[] => [...lastLabels];
