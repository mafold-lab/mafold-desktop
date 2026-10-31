// ── 开窗那一刻盖在窗口上的加载画面:画的是什么、什么时候撤 ──────────────────
// 纯规则(单测在 test/cover.spec.ts);接到 Electron 上的是 cover.ts。
//
// 画的是网页第一帧那一张:client-shared/loadingFrame.ts 的生成副本(sync-shared.mjs),
// 网页(BootCurtain + PAINT_MARKS)和手机(BootCover)画的也是它 —— 只此一份,壳里
// 不另画。底色是 App 的(client-shared/appGround.ts,浅 / 深两档都给,跟着这会儿的
// 深浅色走:那层页面的 prefers-color-scheme 就是壳的 nativeTheme)。正中的图是
// client-shared/loadingIcon.ts 那份字节,内嵌成 data URI:这一层不许加载任何远程地址,
// 网页那张 /mafold-boot-v1.jpg 是网页源上的相对地址,在这里取不到也不该取。
//
// 什么时候撤:主窗口的文档是网页源上的、DOM 好了(dom-ready),再等一帧
// (COVER_HANDOFF_MS)让网页自己那张静止帧先画上(网页挂它的话:登着、bootCurtain 开着
// 的号)—— 图标和底色在同一个位置接上;退场动画(图标飞回徽章)由网页自己播。接不齐的
// 几处:转圈的 400ms 入场延迟两份文档各算各的(盖层上已经出来的转圈交接时隐掉一下再出)、
// 盖层不知道这个号选的强调色(转圈头是默认绿)、冷缓存时网页那张图晚一个请求;网页不挂它
// 的号(没登录、bootCurtain 关着)露出来的是网页自己的门口。
// 加载失败要转离线页了、离线页好了:马上撤,离线页不能卡在盖层底下。
// 主框架提交了文档、迟迟不 DOM 好:从提交那一刻起 COVER_MAX_MS 兜底撤。还什么都没提交就
// 一直盖着 —— 底下什么都没有,撤了窗口只剩一块底色,连「还在加载」都看不出来;连不上
// (拒绝、DNS、连接超时)Chromium 会报 did-fail-load,转离线页时撤。对方收了连接却迟迟
// 不回的,Chromium 报失败之前盖层就一直盖着(图标 + 转圈,如实是「还在加载」;以前这时
// 窗口还没出来)。

import { LOADING_FRAME, loadingFrame, type LoadingGround } from "../shared/loadingFrame.generated";
import { LOADING_ICON_URI } from "../shared/loadingIcon.generated";

/** 网页 DOM 好了(dom-ready)以后再等这么久才撤:让网页那张静止帧先画上一两帧。 */
export const COVER_HANDOFF_MS = 50;
/** 主框架提交了文档、过了这么久还没 DOM 好也撤(从第一次提交起算,还没提交过不算)——
 *  跟网页那张自己淡掉(LOADING_FRAME.lateMs)是同一个数:网页那张也是文档提交以后、
 *  第一帧挂上,挂满这么久自己淡掉,两边差不多同时收。 */
export const COVER_MAX_MS = LOADING_FRAME.lateMs;

/** 主窗口那张页面上发生的、跟盖层有关的事。 */
export type CoverEvent =
  /** 主框架的文档 DOM 好了(webContents 的 dom-ready);`url` 是那份文档的地址。 */
  | { kind: "dom-ready"; url: string }
  /** 主框架提交了一份文档(webContents 的 did-navigate,出错页不算):从这时起底下才有
   *  东西可露,兜底从第一次提交起算。它自己不撤 —— 提交那一刻页面还什么都没画。 */
  | { kind: "navigate" }
  /** 加载失败(did-fail-load)。 */
  | { kind: "fail-load"; code: number; mainFrame: boolean }
  /** 主框架提交了文档以后 COVER_MAX_MS 还没人收。 */
  | { kind: "timeout" };

/** 留着 / 等一帧再撤 / 马上撤。 */
export type CoverStep = "stay" | "soon" | "now";

/** 判断要的两个地址:网页源,和离线页(不带 hash)。 */
export interface CoverAt {
  webOrigin: string;
  offlineUrl: string;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export function coverStep(e: CoverEvent, at: CoverAt): CoverStep {
  switch (e.kind) {
    case "dom-ready":
      if (e.url.split(/[?#]/)[0] === at.offlineUrl) return "now";
      // 空白页、出错页(马上会转离线页)、别的源:都不是网页好了。
      return originOf(e.url) === at.webOrigin ? "soon" : "stay";
    case "navigate":
      return "stay";
    case "fail-load":
      // -3 = ERR_ABORTED:被另一次导航顶掉,不是失败(window.ts 同一条)。
      return e.mainFrame && e.code !== -3 ? "now" : "stay";
    case "timeout":
      return "now";
  }
}

/** 盖层的整页 HTML:只有一张静止画面 —— 没有脚本(那层也不开 JS),CSP 只放行
 *  内联样式和 data: 图。<html data-boot="on"> 直接写在标签里(loadingFrame.ts 认的
 *  就是这个标记);深浅色不写 data-theme,交给 prefers-color-scheme,跟着壳走。 */
export function coverPage(ground: LoadingGround): string {
  const frame = loadingFrame(ground, LOADING_ICON_URI);
  return [
    `<!doctype html><html data-boot="on"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>Mafold</title><style>${frame.css}</style></head>`,
    `<body>${frame.html}</body></html>`,
  ].join("");
}

/** 盖层加载的地址:coverPage 整页放进 data: URL。 */
export const coverUrl = (ground: LoadingGround): string => `data:text/html;base64,${Buffer.from(coverPage(ground), "utf8").toString("base64")}`;

export interface CoverLift {
  /** 还盖着。 */
  readonly up: boolean;
  /** 喂一件事进来。 */
  on(e: CoverEvent): void;
  /** 窗口没了:计时器全撤,再也不调 lift。 */
  dispose(): void;
}

/** 一张盖层的撤法:事件喂进来,该撤时调 `lift` 一次。兜底(COVER_MAX_MS)从主框架第一次
 *  提交文档起算;还没提交过就一直盖着,等网页 DOM 好或者失败转离线页。 */
export function coverLift(at: CoverAt, lift: (why: CoverEvent["kind"]) => void): CoverLift {
  let up = true;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  function stop(): void {
    up = false;
    if (deadline) clearTimeout(deadline);
    if (soon) clearTimeout(soon);
    deadline = soon = null;
  }
  function go(why: CoverEvent["kind"]): void {
    if (!up) return;
    stop();
    lift(why);
  }
  function on(e: CoverEvent): void {
    if (!up) return;
    // 第一次提交:兜底从这时起算;再提交一份(页面自己跳了一下)不重新计时。
    if (e.kind === "navigate" && !deadline) deadline = setTimeout(() => go("timeout"), COVER_MAX_MS);
    const step = coverStep(e, at);
    if (step === "now") go(e.kind);
    // 已经在等那一帧了:再来一次 dom-ready 不重新计时。
    else if (step === "soon" && !soon) soon = setTimeout(() => go(e.kind), COVER_HANDOFF_MS);
  }

  return {
    get up() {
      return up;
    },
    on,
    dispose: stop,
  };
}
