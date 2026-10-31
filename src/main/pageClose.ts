// Closing the page the way closing a BrowserWindow did: its `beforeunload`
// first. The main window is a BaseWindow (window.ts), and a BaseWindow's own
// close takes its views down without a word to their pages — so quitting asks
// the page itself. Its beforeunload is where the composer sends the last of a
// draft to the server (mafold-web chat/MessageInput.tsx); without it a draft
// typed just before ⌘Q stays on this computer until the next launch.

import type { WebContents } from "electron";

/** How long a quit waits for the page to close. Its beforeunload takes a few
 *  milliseconds; this only bounds a page that never answers. */
export const PAGE_CLOSE_GRACE_MS = 1500;

export type ClosablePage = Pick<WebContents, "isDestroyed" | "close" | "once" | "on" | "off">;

/**
 * Close `page` with its beforeunload, and resolve once it is gone — or after
 * `graceMs` regardless, closing it outright then. A page asking to stay
 * (`will-prevent-unload`) is not kept: quitting is the person's call, and a
 * window on its way out has nowhere to ask them.
 */
export function closePage(page: ClosablePage, graceMs = PAGE_CLOSE_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    if (page.isDestroyed()) {
      resolve();
      return;
    }
    const letGo = (e: Electron.Event) => e.preventDefault();
    const done = () => {
      clearTimeout(timer);
      page.off("destroyed", done);
      page.off("will-prevent-unload", letGo);
      if (!page.isDestroyed()) page.close();
      resolve();
    };
    const timer = setTimeout(done, graceMs);
    page.once("destroyed", done);
    page.on("will-prevent-unload", letGo);
    page.close({ waitForBeforeUnload: true });
  });
}
