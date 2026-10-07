// The application menu. Its job on top of the platform basics (an Edit menu —
// without one, ⌘C/⌘V do nothing on macOS) is to give the page native
// shortcuts: each item below sends a `command` the page maps to what it
// already does from the keyboard.

import { app, Menu, type MenuItemConstructorOptions } from "electron";

import type { Shell } from "./shell";
import { installUpdate } from "./updater";
import type { HostCommand } from "../shared/desktopHost.generated";

export function buildMenu(shell: Shell, os: "macos" | "windows" | "linux"): Menu {
  const t = (k: string) => shell.strings.t(k);
  const command = (c: HostCommand) => () => {
    shell.showWindow();
    shell.emit("command", c);
  };
  const go = (label: string, accelerator: string, c: HostCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: command(c),
  });
  const mac = os === "macos";

  const edit: MenuItemConstructorOptions = {
    label: t("desktop.menu.edit"),
    submenu: [
      { role: "undo", label: t("desktop.menu.undo") },
      { role: "redo", label: t("desktop.menu.redo") },
      { type: "separator" },
      { role: "cut", label: t("desktop.menu.cut") },
      { role: "copy", label: t("desktop.menu.copy") },
      { role: "paste", label: t("desktop.menu.paste") },
      ...(mac ? [{ role: "pasteAndMatchStyle", label: t("desktop.menu.pasteAndMatchStyle") } as MenuItemConstructorOptions] : []),
      { role: "delete", label: t("desktop.menu.delete") },
      { role: "selectAll", label: t("desktop.menu.selectAll") },
    ],
  };

  const goMenu: MenuItemConstructorOptions = {
    label: t("desktop.menu.go"),
    submenu: [
      go(t("desktop.menu.newChat"), "CmdOrCtrl+N", "new-chat"),
      go(t("desktop.menu.quickSwitcher"), "CmdOrCtrl+K", "quick-switcher"),
      go(t("desktop.menu.focusComposer"), "CmdOrCtrl+L", "focus-composer"),
      { type: "separator" },
      go(t("desktop.menu.nextChat"), "CmdOrCtrl+Alt+Down", "next-chat"),
      go(t("desktop.menu.prevChat"), "CmdOrCtrl+Alt+Up", "prev-chat"),
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: t("desktop.menu.view"),
    submenu: [
      { role: "reload", label: t("desktop.menu.reload") },
      { type: "separator" },
      { role: "resetZoom", label: t("desktop.menu.actualSize") },
      { role: "zoomIn", label: t("desktop.menu.zoomIn") },
      { role: "zoomOut", label: t("desktop.menu.zoomOut") },
      { type: "separator" },
      { role: "togglefullscreen", label: t("desktop.menu.fullScreen") },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: t("desktop.menu.window"),
    submenu: [
      { role: "minimize", label: t("desktop.menu.minimize") },
      ...(mac ? [{ role: "zoom", label: t("desktop.menu.zoom") } as MenuItemConstructorOptions] : []),
      { role: "close", label: t("desktop.menu.close") },
      { type: "separator" },
      { label: t("desktop.menu.showWindow"), accelerator: "CmdOrCtrl+1", click: () => shell.showWindow() },
      ...(mac ? [{ type: "separator" } as MenuItemConstructorOptions, { role: "front", label: t("desktop.menu.bringAllToFront") } as MenuItemConstructorOptions] : []),
    ],
  };

  const settings: MenuItemConstructorOptions = { label: t("desktop.menu.settings"), accelerator: "CmdOrCtrl+,", click: command("settings") };
  const update: MenuItemConstructorOptions[] = shell.updateReady
    ? [{ label: t("desktop.update.restart"), click: () => installUpdate() }, { type: "separator" }]
    : [];

  const template: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about", label: t("desktop.menu.about") },
            { type: "separator" },
            ...update,
            settings,
            { type: "separator" },
            { role: "hide", label: t("desktop.menu.hide") },
            { role: "hideOthers", label: t("desktop.menu.hideOthers") },
            { role: "unhide", label: t("desktop.menu.showAll") },
            { type: "separator" },
            { role: "quit", label: t("desktop.menu.quit") },
          ],
        },
        edit,
        goMenu,
        view,
        windowMenu,
      ]
    : [
        {
          label: t("desktop.menu.file"),
          submenu: [...update, settings, { type: "separator" }, { role: "quit", label: t("desktop.menu.quit") }],
        },
        edit,
        goMenu,
        view,
        windowMenu,
      ];
  return Menu.buildFromTemplate(template);
}
