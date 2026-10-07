import { describe, expect, it } from "vitest";

import { decideNavigation, decideWindowOpen, isApiDownload, permissionAllowed, shellUserAgent } from "../src/main/policy";

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
