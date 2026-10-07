// Electron shows no context menu by default. This is the browser's ordinary
// one — spelling, edit actions, links, images — for the places the page does
// not draw its own (where the page handles `contextmenu` itself, Chromium never
// asks us).

import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

import { isExternalUrl } from "./policy";
import type { Shell } from "./shell";

export function attachContextMenu(contents: WebContents, shell: Shell): void {
  contents.on("context-menu", (_e, p) => {
    const t = (k: string) => shell.strings.t(k);
    const items: MenuItemConstructorOptions[] = [];

    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: s, click: () => contents.replaceMisspelling(s) });
      }
      items.push({
        label: t("desktop.context.learnSpelling"),
        click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord),
      });
      items.push({ type: "separator" });
    }

    if (p.linkURL && isExternalUrl(p.linkURL)) {
      items.push({ label: t("desktop.context.openLink"), click: () => shell.openExternal(p.linkURL, "context-menu") });
      items.push({ label: t("desktop.context.copyLink"), click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: "separator" });
    }

    if (p.mediaType === "image" && p.srcURL) {
      items.push({ label: t("desktop.context.copyImage"), click: () => contents.copyImageAt(p.x, p.y) });
      if (/^https?:/.test(p.srcURL)) items.push({ label: t("desktop.context.saveImage"), click: () => contents.downloadURL(p.srcURL) });
      items.push({ type: "separator" });
    }

    if (p.isEditable) {
      items.push(
        { role: "cut", label: t("desktop.menu.cut"), enabled: p.editFlags.canCut },
        { role: "copy", label: t("desktop.menu.copy"), enabled: p.editFlags.canCopy },
        { role: "paste", label: t("desktop.menu.paste"), enabled: p.editFlags.canPaste },
        { role: "selectAll", label: t("desktop.menu.selectAll"), enabled: p.editFlags.canSelectAll },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: "copy", label: t("desktop.menu.copy") });
    }

    while (items.length && items[items.length - 1].type === "separator") items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: shell.window ?? undefined });
  });
}
