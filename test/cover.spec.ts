// coverPlan.ts:开窗时盖在窗口上的那层加载画面(更新胶囊 D5)——画的是什么、
// 什么时候撤。以前窗口要等网页第一帧(ready-to-show)才出来,网络慢时点了图标
// 好几秒什么都没有;现在窗口当场出来,上面盖着跟网页第一帧同一张静止画面,
// 网页好了再撤。
//
// 画的必须就是网页那一张:都从 client-shared/loadingFrame.ts 的生成副本出,
// 正中的图标是 client-shared/loadingIcon.ts 那份字节(这一层不许加载任何远程
// 地址,所以图是内嵌的 data URI,不是网页用的 /mafold-boot-v1.jpg)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COVER_HANDOFF_MS, COVER_MAX_MS, coverLift, coverPage, coverStep, coverUrl, type CoverEvent } from "../src/main/coverPlan";
import { APP_GROUND } from "../src/shared/appGround.generated";
import { LOADING_FRAME, loadingFrame } from "../src/shared/loadingFrame.generated";
import { LOADING_ICON_URI } from "../src/shared/loadingIcon.generated";

const WEB = "https://mafold.com";
const OFFLINE = "file:///Applications/Mafold.app/Contents/Resources/app.asar/static/offline.html";
const at = { webOrigin: WEB, offlineUrl: OFFLINE };

describe("盖层画的就是网页第一帧那一张", () => {
  const page = coverPage(APP_GROUND);
  const frame = loadingFrame(APP_GROUND, LOADING_ICON_URI);

  it("同一份样式、同一个元素(loadingFrame 生成副本),底色是 App 的两档", () => {
    expect(page).toContain(frame.css);
    expect(page).toContain(frame.html);
    expect(page).toContain(APP_GROUND.light);
    expect(page).toContain(APP_GROUND.dark);
  });

  it("一打开就挂着(<html data-boot=\"on\"> 写在标签里,不靠脚本)", () => {
    expect(page).toMatch(/<html[^>]*\sdata-boot="on"/);
  });

  it("正中的图是内嵌的那份字节,不去取网页上那张", () => {
    expect(page).toContain(`url("${LOADING_ICON_URI}")`);
    expect(page).not.toContain(LOADING_FRAME.icon.src);
  });

  it("只是一张静止画面:没有脚本,CSP 只放行内联样式和 data: 图", () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
    expect(page).not.toMatch(/https?:\/\//);
  });

  it("data: URL 里装的就是这一页", () => {
    const url = coverUrl(APP_GROUND);
    expect(url.startsWith("data:text/html;base64,")).toBe(true);
    expect(Buffer.from(url.slice("data:text/html;base64,".length), "base64").toString("utf8")).toBe(page);
  });
});

describe("coverStep:什么时候撤", () => {
  const step = (e: CoverEvent) => coverStep(e, at);

  it("网页源上的文档 DOM 好了:等一帧再撤(让网页那张静止帧先画上)", () => {
    expect(step({ kind: "dom-ready", url: `${WEB}/app` })).toBe("soon");
    expect(step({ kind: "dom-ready", url: `${WEB}/app?x=1#0f8fad5b-d9cb-469f-a165-70867728950e` })).toBe("soon");
    expect(step({ kind: "dom-ready", url: `${WEB}/` })).toBe("soon");
  });

  it("离线页:马上撤", () => {
    expect(step({ kind: "dom-ready", url: `${OFFLINE}#%7B%7D` })).toBe("now");
    expect(step({ kind: "dom-ready", url: OFFLINE })).toBe("now");
  });

  it("别的文档(空白页、出错页、别的源)不算网页好了:留着", () => {
    expect(step({ kind: "dom-ready", url: "about:blank" })).toBe("stay");
    expect(step({ kind: "dom-ready", url: "chrome-error://chromewebdata/" })).toBe("stay");
    expect(step({ kind: "dom-ready", url: "https://mafold.com.evil.example/app" })).toBe("stay");
    expect(step({ kind: "dom-ready", url: "http://mafold.com/app" })).toBe("stay");
    expect(step({ kind: "dom-ready", url: "" })).toBe("stay");
    expect(step({ kind: "dom-ready", url: "not a url" })).toBe("stay");
  });

  it("主框架加载失败(要转离线页了):马上撤", () => {
    expect(step({ kind: "fail-load", code: -105, mainFrame: true })).toBe("now");
    expect(step({ kind: "fail-load", code: -102, mainFrame: true })).toBe("now");
  });

  it("被另一次导航顶掉(-3)、子框架失败:都不算,留着", () => {
    expect(step({ kind: "fail-load", code: -3, mainFrame: true })).toBe("stay");
    expect(step({ kind: "fail-load", code: -105, mainFrame: false })).toBe("stay");
  });

  it("主框架提交了一份文档(did-navigate)本身不撤:那一刻它还什么都没画", () => {
    expect(step({ kind: "navigate" })).toBe("stay");
  });

  it("盖太久了:马上撤", () => {
    expect(step({ kind: "timeout" })).toBe("now");
  });
});

describe("coverLift:一张盖层从盖上到撤掉", () => {
  let lifted: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    lifted = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const raise = () => coverLift(at, (why) => lifted.push(why));

  it("网页 DOM 好了以后过 COVER_HANDOFF_MS 才撤", () => {
    const c = raise();
    expect(c.up).toBe(true);
    c.on({ kind: "dom-ready", url: `${WEB}/app` });
    vi.advanceTimersByTime(COVER_HANDOFF_MS - 1);
    expect(lifted).toEqual([]);
    expect(c.up).toBe(true);
    vi.advanceTimersByTime(1);
    expect(lifted).toEqual(["dom-ready"]);
    expect(c.up).toBe(false);
  });

  it("加载失败:当场撤", () => {
    const c = raise();
    c.on({ kind: "fail-load", code: -105, mainFrame: true });
    expect(lifted).toEqual(["fail-load"]);
    expect(c.up).toBe(false);
  });

  it("离线页 DOM 好了:当场撤", () => {
    const c = raise();
    c.on({ kind: "dom-ready", url: `${OFFLINE}#x` });
    expect(lifted).toEqual(["dom-ready"]);
  });

  it("提交了文档、别的文档好了不撤;迟迟不 DOM 好:从提交那一刻起 COVER_MAX_MS 兜底撤", () => {
    const c = raise();
    vi.advanceTimersByTime(3000); // 网页在路上
    c.on({ kind: "navigate" });
    c.on({ kind: "dom-ready", url: "about:blank" });
    c.on({ kind: "fail-load", code: -3, mainFrame: true });
    vi.advanceTimersByTime(COVER_MAX_MS - 1);
    expect(lifted).toEqual([]);
    expect(c.up).toBe(true);
    vi.advanceTimersByTime(1);
    expect(lifted).toEqual(["timeout"]);
    expect(c.up).toBe(false);
  });

  it("还什么都没提交:到点了也接着盖着(撤了窗口只剩一块底色),等网页 DOM 好或者失败转离线页", () => {
    const c = raise();
    vi.advanceTimersByTime(COVER_MAX_MS * 5);
    expect(lifted).toEqual([]);
    expect(c.up).toBe(true);
    c.on({ kind: "fail-load", code: -105, mainFrame: true });
    expect(lifted).toEqual(["fail-load"]);
  });

  it("过了 COVER_MAX_MS 才提交:提交那一下不撤,兜底从提交起再算;其间网页 DOM 好了照常等一帧撤", () => {
    const c = raise();
    vi.advanceTimersByTime(COVER_MAX_MS * 2);
    c.on({ kind: "navigate" });
    expect(lifted).toEqual([]);
    vi.advanceTimersByTime(COVER_MAX_MS / 2);
    expect(lifted).toEqual([]);
    c.on({ kind: "dom-ready", url: `${WEB}/app` });
    vi.advanceTimersByTime(COVER_HANDOFF_MS);
    expect(lifted).toEqual(["dom-ready"]);
  });

  it("兜底只从第一次提交算:再提交一份(比如页面自己跳了一下)不重新计时", () => {
    const c = raise();
    vi.advanceTimersByTime(1000);
    c.on({ kind: "navigate" });
    vi.advanceTimersByTime(10_000);
    c.on({ kind: "navigate" });
    vi.advanceTimersByTime(COVER_MAX_MS - 10_000 - 1);
    expect(lifted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(lifted).toEqual(["timeout"]);
  });

  it("兜底跟网页那张自己淡掉是同一个数(网页那张也是提交以后挂上、挂满 lateMs 自己淡掉)", () => {
    expect(COVER_MAX_MS).toBe(LOADING_FRAME.lateMs);
  });

  it("只撤一次:撤了以后再来什么都不算", () => {
    const c = raise();
    c.on({ kind: "dom-ready", url: `${WEB}/app` });
    c.on({ kind: "fail-load", code: -105, mainFrame: true });
    c.on({ kind: "dom-ready", url: `${WEB}/app` });
    vi.advanceTimersByTime(COVER_MAX_MS * 2);
    expect(lifted).toEqual(["fail-load"]);
  });

  it("窗口没了(dispose):再也不撤,计时器也不留", () => {
    const c = raise();
    c.on({ kind: "navigate" });
    c.on({ kind: "dom-ready", url: `${WEB}/app` });
    c.dispose();
    vi.advanceTimersByTime(COVER_MAX_MS * 2);
    expect(lifted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
