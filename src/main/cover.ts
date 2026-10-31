// ── 开窗先画加载画面 —— 更新胶囊 D5 ─────────────────────────────────────
// 以前主窗口建好先藏着,等网页第一帧(ready-to-show)才出来:网络慢时点了图标好几秒
// 什么都没有。现在窗口当场出来(window.ts),上面盖一层只放静止画面的子视图,网页好了
// 再撤。画什么、什么时候撤在 coverPlan.ts(纯规则):画的是网页第一帧那一张
// (client-shared/loadingFrame.ts),网页 DOM 好了再等一帧撤 —— 网页挂着自己那张的话
// (登着、bootCurtain 开着),那时它已经在同一个位置画上,图标和底色接得上;接不齐的几处
// (转圈、强调色、冷缓存的图,没挂它的号)见 coverPlan.ts 开头。退场动画全由网页播。
// 主框架还什么都没提交时不撤(撤了只剩一块底色),提交了迟迟不好才 20 秒兜底。
//
// 为什么是盖一层,不是先开一张本地页再跳网页:那样本地页会留在后退记录里,还多一次
// did-navigate(window.ts 的 newDocument:订阅清空、系统红绿灯回来),file: → https:
// 跨源跳转中间还可能露一帧空底色。盖层跟主窗口的页面互不相干:主窗口照常 loadURL。
//
// 这一层只是一张静止画面(security.ts 的规矩:不给 node、不给 preload、沙盒、隔离):
// 不开 JS,不给 preload,文档是 data: URL、CSP 只放行内联样式和 data: 图,哪儿也
// 不许去(拦导航、拒开窗);不在主窗口的会话(persist:mafold)里,碰不到网页的
// cookie 和存储;bridge 只认主窗口的主框架(bridge.ts fromOurPage),它够不着。
// 撤的时候从窗口上拿下来并关掉(webContents.close()):只拿下来不关的话那层页面
// 还活着,白占一个渲染进程。

import { nativeTheme, WebContentsView, type BaseWindow, type Rectangle, type WebContents } from "electron";

import { coverLift, coverUrl, type CoverAt, type CoverLift } from "./coverPlan";
import { log } from "./log";
import { APP_GROUND } from "../shared/appGround.generated";

/** 现在盖着的那一层(只有一个主窗口)。 */
let showing: { view: WebContentsView; lift: CoverLift } | null = null;

/** 给主窗口盖上加载画面,到时候自己撤。`ground` 是这会儿深浅色的 App 底色
 *  (window.ts 的 ground()):那层页面画出来之前,露出来的也是它。`page`:主窗口的页面
 *  (窗口里的一层子视图,window.ts);`frame`:它在窗口里的位置 —— macOS 手机布局下壳自己的
 *  标题栏在它上面(frame.ts),盖层只盖页面那一块,标题栏照常露着。 */
export function raiseCover(
  win: BaseWindow,
  opts: CoverAt & { ground: () => string; page: WebContents; frame: { pageBounds(): Rectangle; follow(fn: () => void): () => void } },
): void {
  const view = new WebContentsView({
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const cover: WebContents = view.webContents;
  view.setBackgroundColor(opts.ground());
  // 它自己哪儿也不去:没有链接、没有脚本,有也拦下。
  cover.on("will-navigate", (e) => e.preventDefault());
  cover.setWindowOpenHandler(() => ({ action: "deny" }));

  // 页面那一层每次排好位置(frame.ts),盖层跟着 —— 窗口改大小也在其中。
  const fit = () => {
    if (!win.isDestroyed()) view.setBounds(opts.frame.pageBounds());
  };
  fit();
  win.contentView.addChildView(view);
  const unfollow = opts.frame.follow(fit);
  // 深浅色换了:底色跟着(页面自己的跟着 prefers-color-scheme)。
  const reground = () => view.setBackgroundColor(opts.ground());
  nativeTheme.on("updated", reground);

  const main = opts.page;
  // did-navigate 只报主框架、只报真提交了的文档(出错页走 did-fail-load):兜底从它起算。
  const committed = () => lift.on({ kind: "navigate" });
  const domReady = () => lift.on({ kind: "dom-ready", url: main.getURL() });
  const failed = (_e: Electron.Event, code: number, _desc: string, _url: string, isMainFrame: boolean) =>
    lift.on({ kind: "fail-load", code, mainFrame: isMainFrame });
  main.on("did-navigate", committed);
  main.on("dom-ready", domReady);
  main.on("did-fail-load", failed);

  const t0 = Date.now();
  let down = false;
  const takeDown = () => {
    if (down) return;
    down = true;
    showing = null;
    main.off("did-navigate", committed);
    main.off("dom-ready", domReady);
    main.off("did-fail-load", failed);
    nativeTheme.off("updated", reground);
    unfollow();
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(view);
      // 盖着时点过窗口,键盘焦点可能在这层上:还给页面。
      if (win.isFocused()) main.focus();
    }
    if (!cover.isDestroyed()) cover.close();
  };
  const lift = coverLift(opts, (why) => {
    log("cover lifted:", why, `${Date.now() - t0}ms`);
    takeDown();
  });
  win.once("closed", () => {
    lift.dispose();
    takeDown();
  });

  showing = { view, lift };
  void cover.loadURL(coverUrl(APP_GROUND)).catch((err: unknown) => log("cover failed to load:", String(err)));
}

/** 测试钩子:盖层还在不在。 */
export const coverUp = (): boolean => !!showing?.lift.up;

/** 测试钩子:盖层在窗口里的位置和大小(没盖着时 null)。 */
export const coverBounds = (): Rectangle | null => (showing ? showing.view.getBounds() : null);
