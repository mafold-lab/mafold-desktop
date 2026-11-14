import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isHostCommand, readAppearance, readAuthorizeUrl, readEventName, readLocale, readNotification, readUnread, readWindowAction, readWindowLayout, sameUnread, readSiteAct, readAgentName, readGrantId, readTabId, readAgentRef, MAX_AGENT_TEXT } from "../src/main/validate";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("bridge payloads", () => {
  it("keeps only well-formed unread rows, clipped", () => {
    const u = readUnread({
      total: 3.7,
      top: [
        { convId: ID, title: "x".repeat(200), preview: "a\n\nb", count: 2 },
        { convId: "not-an-id", title: "dropped", count: 1 },
        "junk",
      ],
    })!;
    expect(u.total).toBe(3);
    expect(u.top).toHaveLength(1);
    expect(u.top[0].title).toHaveLength(80);
    expect(u.top[0].preview).toBe("a b");
    expect(readUnread(null)).toBeNull();
    expect(readUnread({ total: -5 })!.total).toBe(0);
    expect(readUnread({ total: 1, top: Array.from({ length: 50 }, () => ({ convId: ID })) })!.top).toHaveLength(8);
  });

  it("tells a summary that would redraw the tray from one that would not", () => {
    const a = readUnread({ total: 3, top: [{ convId: ID, title: "T", preview: "p", count: 3 }] })!;
    expect(sameUnread(a, readUnread({ total: 3, top: [{ convId: ID, title: "T", preview: "p", count: 3 }] })!)).toBe(true);
    expect(sameUnread(a, readUnread({ total: 3, top: [{ convId: ID, title: "T", preview: "p2", count: 3 }] })!)).toBe(false);
    expect(sameUnread(a, readUnread({ total: 4, top: [{ convId: ID, title: "T", preview: "p", count: 3 }] })!)).toBe(false);
    expect(sameUnread(a, readUnread({ total: 3, top: [] })!)).toBe(false);
  });

  it("needs a conversation id and a title to notify", () => {
    expect(readNotification({ convId: ID, title: "T", body: "B", silent: true })).toEqual({
      convId: ID, msgId: undefined, title: "T", body: "B", silent: true,
    });
    expect(readNotification({ convId: ID, title: "" })).toBeNull();
    expect(readNotification({ convId: "x", title: "T" })).toBeNull();
    expect(readNotification({ convId: ID, msgId: "bad", title: "T" })!.msgId).toBeUndefined();
  });

  it("accepts only https authorization pages", () => {
    expect(readAuthorizeUrl("https://github.com/login/oauth/authorize?x=1")).toBeTruthy();
    for (const bad of ["http://github.com/", "file:///x", "javascript:1", 5, "x".repeat(9000)]) expect(readAuthorizeUrl(bad)).toBeNull();
  });

  it("knows the enums", () => {
    expect(readAppearance("dark")).toBe("dark");
    expect(readAppearance("blue")).toBeNull();
    expect(readEventName("navigate")).toBe("navigate");
    expect(readEventName("window")).toBe("window");
    expect(readEventName("notify-permission")).toBe("notify-permission");
    // Without it a page's subscription is dropped silently (bridge.ts) and it never hears an update.
    expect(readEventName("update")).toBe("update");
    expect(readEventName("eval")).toBeNull();
    const actions = ["close", "minimize", "zoom", "fullscreen", "fill", "center", "tile-left", "tile-right"];
    expect(actions.map(readWindowAction)).toEqual(actions);
    expect([undefined, "quit", "tile-top", "FULLSCREEN", { a: "close" }].map(readWindowAction)).toEqual([null, null, null, null, null]);
    expect(["phone", "wide"].map(readWindowLayout)).toEqual(["phone", "wide"]);
    expect([undefined, "", "Phone", "desktop", 1, { layout: "phone" }].map(readWindowLayout)).toEqual([null, null, null, null, null, null]);
    expect(isHostCommand("new-chat")).toBe(true);
    expect(isHostCommand("rm -rf")).toBe(false);
    expect(readLocale("zh-Hans", { a: "b" })).toEqual({ lang: "zh-Hans", strings: { a: "b" } });
    expect(readLocale("../../x", {})).toBeNull();
  });
});

describe("strings snapshot", () => {
  it("has every desktop.* key the shell uses", () => {
    const table = JSON.parse(readFileSync(join(__dirname, "../static/strings.json"), "utf8")) as Record<string, Record<string, string>>;
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else for (const m of readFileSync(p, "utf8").matchAll(/"(desktop\.[a-zA-Z.]+)"/g)) used.add(m[1]);
      }
    };
    walk(join(__dirname, "../src/main"));
    expect(used.size).toBeGreaterThan(20);
    for (const [lang, strings] of Object.entries(table)) {
      for (const k of used) expect(strings[k], `${lang} ${k}`).toBeTruthy();
    }
  });
});

describe("site-agent payloads", () => {
  it("takes one act of a known shape, and nothing else", () => {
    expect(readSiteAct({ click: { x: 10.4, y: 20.6 } })).toEqual({ click: { x: 10, y: 21 } });
    expect(readSiteAct({ type: "hello" })).toEqual({ type: "hello" });
    expect(readSiteAct({ key: "Enter" })).toEqual({ key: "Enter" });
    expect(readSiteAct({ scroll: 99_999 })).toEqual({ scroll: 5000 });
    expect(readSiteAct({ goto: "https://example.com/a?b" })).toEqual({ goto: "https://example.com/a?b" });
    for (const bad of [
      null,
      "click",
      {},
      { click: { x: -1, y: 2 } },
      { click: { x: "1", y: 2 } },
      { click: { x: 1, y: 2 }, type: "two at once" },
      { type: "" },
      { type: "x".repeat(MAX_AGENT_TEXT + 1) },
      { key: "F12" },
      { scroll: Number.NaN },
      { goto: "javascript:alert(1)" },
      { goto: "file:///etc/passwd" },
      { goto: "not a url" },
      { eval: "1" },
    ]) {
      expect(readSiteAct(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("names, grants, tabs and refs", () => {
    expect(readAgentName("opsdu:claude-code")).toBe("opsdu:claude-code");
    expect(readAgentName("Claude\nAllow?")).toBeNull();
    expect(readAgentName("")).toBeNull();
    expect(readGrantId("0b6f3f4e-6f39-4f43-a3a1-3e3f9f0d2a11")).toBe("0b6f3f4e-6f39-4f43-a3a1-3e3f9f0d2a11");
    expect(readGrantId("../../x")).toBeNull();
    expect(readTabId(12)).toBe(12);
    expect(readTabId(0)).toBeNull();
    expect(readTabId(1.5)).toBeNull();
    expect(readAgentRef("  Sign \n in ")).toBe("Sign in");
    expect(readAgentRef("   ")).toBeNull();
    expect(readAgentRef("x".repeat(500))!.length).toBeLessThanOrEqual(120);
  });
});
