import { describe, expect, it } from "vitest";

import {
  decideNavigation,
  decideSiteNavigation,
  decideWindowOpen,
  hardenSite,
  isApiDownload,
  mayAttachSite,
  permissionAllowed,
  shellUserAgent,
  siteAsks,
  sitePermission,
  siteQuestion,
  siteShortcut,
  siteUserAgent,
} from "../src/main/policy";
import { SITE_PARTITION } from "../src/shared/desktopHost.generated";

describe("shellUserAgent", () => {
  it("drops Electron's and the app's tokens and names the desktop app", () => {
    const electron =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Mafold/0.1.0 Chrome/144.0.7559.60 Electron/44.5.1 Safari/537.36";
    expect(shellUserAgent(electron, "0.1.0")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Safari/537.36 MafoldDesktop/0.1.0",
    );
    // Idempotent: applying it to its own output keeps a single token.
    expect(shellUserAgent(shellUserAgent(electron, "0.1.0"), "0.1.1").match(/MafoldDesktop\/\S+/g)).toEqual(["MafoldDesktop/0.1.1"]);
  });
});

const o = { webOrigin: "https://mafold.com", apiOrigin: "https://api.mafold.com" };

describe("decideNavigation", () => {
  it("stays on the web origin", () => {
    for (const u of ["https://mafold.com/app", "https://mafold.com/app#x", "https://mafold.com/login/device?code=AB"]) {
      expect(decideNavigation(u, o), u).toBe("allow");
    }
  });
  it("turns api downloads into downloads", () => {
    expect(decideNavigation("https://api.mafold.com/download/abc", o)).toBe("download");
    expect(isApiDownload("https://api.mafold.com/media/abc", o)).toBe(false);
  });
  it("sends every other web page to the system browser", () => {
    for (const u of ["https://github.com/x", "http://example.com", "https://www.mafold.com/", "https://api.mafold.com/media/1", "mailto:a@b.c", "tel:+1"]) {
      expect(decideNavigation(u, o), u).toBe("external");
    }
  });
  it("refuses everything that would run something locally", () => {
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "ms-settings:", "smb://host/x", "not a url"]) {
      expect(decideNavigation(u, o), u).toBe("deny");
    }
  });
  describe("with the page taking links as tabs", () => {
    it("takes a web page there: a checkout is the page being sent off to one", () => {
      for (const u of ["https://checkout.stripe.com/c/pay/cs_x", "https://billing.stripe.com/p/session/x", "http://example.com", "https://www.mafold.com/"]) {
        expect(decideNavigation(u, o, true), u).toBe("tab");
      }
    });
    it("changes nothing else", () => {
      expect(decideNavigation("https://mafold.com/app", o, true)).toBe("allow");
      expect(decideNavigation("https://api.mafold.com/download/abc", o, true)).toBe("download");
      expect(decideNavigation("mailto:a@b.c", o, true)).toBe("external");
      expect(decideNavigation("tel:+1", o, true)).toBe("external");
      expect(decideNavigation("javascript:alert(1)", o, true)).toBe("deny");
      expect(decideNavigation("vscode://x", o, true)).toBe("deny");
    });
  });
});

describe("decideWindowOpen, with the page taking links as tabs", () => {
  const way = (over: Partial<Parameters<typeof decideWindowOpen>[3]> = {}) => ({ disposition: "foreground-tab", features: "", frameName: "", site: false, tabs: true, ...over });
  const page = "https://mafold.com/app";

  it("opens a plain click from anywhere as a tab", () => {
    expect(decideWindowOpen("https://github.com/x", page, o, way())).toBe("tab");
    expect(decideWindowOpen("https://example.com", "", o, way())).toBe("tab"); // an HTML card
    expect(decideWindowOpen("https://example.com", "https://app.example.com/", o, way())).toBe("tab"); // a mini-app
    expect(decideWindowOpen("https://b.example/", "https://a.example/", o, way({ site: true }))).toBe("tab");
  });

  it("sends ⌘/Ctrl-click and shift-click to the system browser", () => {
    expect(decideWindowOpen("https://github.com/x", page, o, way({ disposition: "background-tab" }))).toBe("external");
    expect(decideWindowOpen("https://github.com/x", page, o, way({ disposition: "new-window" }))).toBe("external");
    expect(decideWindowOpen("https://b.example/", "https://a.example/", o, way({ site: true, disposition: "background-tab" }))).toBe("external");
  });

  it("keeps a third party's popups in a window: a sign-in talks back through window.opener", () => {
    const sized = { disposition: "new-window", features: "width=500,height=600" };
    expect(decideWindowOpen("https://accounts.example/auth", "https://app.example/", o, way(sized))).toBe("child");
    expect(decideWindowOpen("https://accounts.example/auth", "", o, way({ ...sized, site: true }))).toBe("child");
    expect(decideWindowOpen("https://accounts.example/auth", "https://app.example/", o, way({ frameName: "signin" }))).toBe("child");
  });

  it("gives our own page no popups: sized or not, a link is a tab", () => {
    expect(decideWindowOpen("https://github.com/x", page, o, way({ disposition: "new-window", features: "width=500" }))).toBe("tab");
    expect(decideWindowOpen("https://example.com", "", o, way({ disposition: "new-window", features: "width=500" }))).toBe("tab"); // an HTML card
    expect(decideWindowOpen("https://github.com/x", page, o, way({ tabs: false, disposition: "new-window", features: "width=500" }))).toBe("external");
  });

  it("lets a site reserve its popup before it knows the address", () => {
    expect(decideWindowOpen("about:blank", "", o, way({ site: true }))).toBe("child");
    expect(decideWindowOpen("about:blank", "", o, way({ site: true, tabs: false, disposition: "new-window", features: "width=500" }))).toBe("child");
  });

  it("noopener is not a size", () => {
    expect(decideWindowOpen("https://github.com/x", page, o, way({ features: "noopener,noreferrer" }))).toBe("tab");
  });

  it("leaves mailto and tel to the system, and refuses the rest", () => {
    expect(decideWindowOpen("mailto:x@y.z", page, o, way())).toBe("external");
    expect(decideWindowOpen("tel:+1", "https://a.example/", o, way({ site: true }))).toBe("external");
    expect(decideWindowOpen("file:///x", page, o, way())).toBe("deny");
    expect(decideWindowOpen("about:blank", page, o, way())).toBe("deny");
  });

  it("with nobody listening, a site's links go to the system browser and its popups stay windows", () => {
    expect(decideWindowOpen("https://b.example/", "https://a.example/", o, way({ site: true, tabs: false }))).toBe("external");
    expect(decideWindowOpen("https://b.example/", "", o, way({ site: true, tabs: false, disposition: "new-window", features: "width=1" }))).toBe("child");
  });
});

describe("a site on a tab", () => {
  it("goes anywhere on the web, leaves mailto and tel to the system, and launches nothing", () => {
    expect(decideSiteNavigation("https://example.com/a")).toBe("allow");
    expect(decideSiteNavigation("http://example.com/a")).toBe("allow");
    expect(decideSiteNavigation("about:blank")).toBe("allow");
    expect(decideSiteNavigation("mailto:a@b.c")).toBe("external");
    expect(decideSiteNavigation("tel:+1")).toBe("external");
    for (const u of ["file:///etc/passwd", "vscode://x", "mafold://link", "javascript:alert(1)", "nonsense"]) expect(decideSiteNavigation(u), u).toBe("deny");
  });

  it("may stand only on our page, in the sites' own partition, showing the web", () => {
    const ok = { partition: SITE_PARTITION, src: "https://github.com/" };
    expect(mayAttachSite("https://mafold.com/app", ok, o)).toBe(true);
    expect(mayAttachSite("https://evil.example/", ok, o)).toBe(false);
    expect(mayAttachSite("file:///offline.html", ok, o)).toBe(false);
    expect(mayAttachSite("https://mafold.com/app", { ...ok, partition: "persist:mafold" }, o)).toBe(false);
    expect(mayAttachSite("https://mafold.com/app", { ...ok, partition: undefined }, o)).toBe(false);
    expect(mayAttachSite("https://mafold.com/app", { ...ok, src: "file:///etc/passwd" }, o)).toBe(false);
    expect(mayAttachSite("https://mafold.com/app", { ...ok, src: undefined }, o)).toBe(false);
  });

  it("gets nothing of the shell's, whatever the tag asked for", () => {
    const prefs: Record<string, unknown> = {
      preload: "/x.js",
      additionalArguments: ["--mafold-web-origin=https://mafold.com"],
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
      enableBlinkFeatures: "x",
    };
    hardenSite(prefs);
    expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, plugins: true });
    for (const k of ["preload", "additionalArguments", "enableBlinkFeatures"]) expect(prefs).not.toHaveProperty(k);
  });

  it("asks for the camera, microphone, location and clipboard, gets the harmless ones, and nothing else", () => {
    for (const p of ["fullscreen", "clipboard-sanitized-write", "pointerLock"]) expect(sitePermission(p), p).toBe("allow");
    for (const p of ["media", "geolocation", "clipboard-read"]) expect(sitePermission(p), p).toBe("ask");
    for (const p of ["notifications", "openExternal", "midiSysex", "storage-access", "unknown"]) expect(sitePermission(p), p).toBe("deny");
  });

  it("names what it asks", () => {
    expect(siteAsks("media", ["audio", "video"])).toEqual(["microphone", "camera"]);
    expect(siteAsks("media", ["unknown"])).toEqual([]);
    expect(siteAsks("media")).toEqual([]);
    expect(siteAsks("geolocation")).toEqual(["location"]);
    expect(siteAsks("clipboard-read")).toEqual(["clipboard"]);
    expect(siteQuestion(["microphone", "camera"])).toBe("desktop.site.ask.cameraAndMicrophone");
    expect(siteQuestion(["location"])).toBe("desktop.site.ask.location");
  });

  it("says it is a browser", () => {
    expect(siteUserAgent("Mozilla/5.0 (X11) Chrome/152 Safari/537.36 mafold-desktop/0.1.5 Electron/44.5.1 MafoldDesktop/0.1.5")).toBe("Mozilla/5.0 (X11) Chrome/152 Safari/537.36");
  });

  const key = (over: Partial<Parameters<typeof siteShortcut>[0]>) => ({ type: "keyDown", key: "", control: false, meta: false, alt: false, shift: false, ...over });
  it("answers a tab's keys", () => {
    expect(siteShortcut(key({ key: "w", meta: true }), true)).toBe("close-tab");
    expect(siteShortcut(key({ key: "w", control: true }), false)).toBe("close-tab");
    expect(siteShortcut(key({ key: "L", control: true }), false)).toBe("focus-address");
    expect(siteShortcut(key({ key: "[", meta: true }), true)).toBe("back");
    expect(siteShortcut(key({ key: "]", meta: true }), true)).toBe("forward");
    expect(siteShortcut(key({ key: "ArrowLeft", alt: true }), false)).toBe("back");
    expect(siteShortcut(key({ key: "ArrowRight", alt: true }), false)).toBe("forward");
  });

  it("leaves every other key to the site", () => {
    expect(siteShortcut(key({ key: "w" }), true)).toBeNull();
    expect(siteShortcut(key({ key: "w", control: true }), true)).toBeNull(); // ⌃W on a Mac is the site's
    expect(siteShortcut(key({ key: "w", meta: true, shift: true }), true)).toBeNull();
    expect(siteShortcut(key({ key: "ArrowLeft", alt: true }), true)).toBeNull(); // ⌥← is a word on a Mac
    expect(siteShortcut(key({ type: "keyUp", key: "w", meta: true }), true)).toBeNull();
  });
});

describe("decideWindowOpen", () => {
  it("opens our own page's links in the system browser", () => {
    expect(decideWindowOpen("https://github.com/x", "https://mafold.com/", o)).toBe("external");
    expect(decideWindowOpen("https://mafold.com/support", "https://mafold.com/app", o)).toBe("external");
  });
  it("treats a referrer-less popup (an HTML card) as external", () => {
    expect(decideWindowOpen("https://example.com", "", o)).toBe("external");
  });
  it("keeps a third-party page's popup in a child window (its opener survives)", () => {
    expect(decideWindowOpen("https://accounts.example.com/auth", "https://app.example.com/", o)).toBe("child");
  });
  it("never opens a non-web scheme as a child", () => {
    expect(decideWindowOpen("mailto:x@y.z", "https://app.example.com/", o)).toBe("external");
    expect(decideWindowOpen("file:///x", "https://mafold.com/", o)).toBe("deny");
    expect(decideWindowOpen("about:blank", "https://mafold.com/", o)).toBe("deny");
  });
});

describe("permissionAllowed", () => {
  const ask = (permission: string, extra: Partial<Parameters<typeof permissionAllowed>[0]> = {}) =>
    permissionAllowed({ permission, requestingOrigin: "https://mafold.com/app", isMainFrame: true, ...extra }, o);

  it("gives the web's top frame notifications, clipboard writes, fullscreen", () => {
    expect(ask("notifications")).toBe(true);
    expect(ask("clipboard-sanitized-write")).toBe(true);
    expect(ask("fullscreen")).toBe(true);
  });
  it("gives the microphone, never the camera or the screen", () => {
    expect(ask("media", { mediaTypes: ["audio"] })).toBe(true);
    expect(ask("media", { mediaTypes: ["video"] })).toBe(false);
    expect(ask("media", { mediaTypes: ["audio", "video"] })).toBe(false);
    expect(ask("media", { mediaTypes: [] })).toBe(false);
    expect(ask("display-capture")).toBe(false);
  });
  it("lets mailto:/tel: links out, nothing else", () => {
    expect(ask("openExternal", { externalURL: "mailto:a@b.c" })).toBe(true);
    expect(ask("openExternal", { externalURL: "vscode://x" })).toBe(false);
  });
  it("refuses everything else, and anything asked by another origin", () => {
    for (const p of ["geolocation", "midi", "hid", "serial", "usb", "clipboard-read", "pointerLock", "idle-detection"]) {
      expect(ask(p), p).toBe(false);
    }
    expect(ask("notifications", { requestingOrigin: "https://evil.example" })).toBe(false);
    expect(ask("notifications", { isMainFrame: false })).toBe(false);
  });
  it("lets any frame write the clipboard (webview mini-apps declare clipboard-write)", () => {
    expect(ask("clipboard-sanitized-write", { requestingOrigin: "https://app.example.com", isMainFrame: false })).toBe(true);
  });
});
