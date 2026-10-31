// GENERATED from client-shared/loadingFrame.ts — DO NOT EDIT.
// ── 加载画面的静止帧 ─────────────────────────────────────────────────────
// Mafold 的窗口从第一帧起、到第一屏好之前显示的东西:App 的底色,正中一块
// App 图标,慢的时候图标下面才出一个转圈。第一帧保证的是底色;图标是 CSS 背景
// 图,画面挂上时才开始取 —— 在缓存里时随即出现,冷缓存时晚一个请求。
// 只此一份,谁要画都从这里取:网页
// 第一帧(mafold-web/src/app/BootCurtain.tsx,React 还没有时由阻塞脚本
// PAINT_MARKS 拉起)、手机的加载画面(mafold-rn/src/components/BootCover.tsx,
// 直接 import 这个文件,只用这里的数 —— 几何、时长、曲线;下面生成 HTML/CSS 的
// 两个函数手机不用),还有桌面壳开窗时盖在还在加载的窗口上的那层(mafold-desktop/
// src/main/coverPlan.ts:整页就是 loadingFrame(),图换成 client-shared/loadingIcon.ts
// 的 data URI —— 那层不加载任何远程地址;网页 DOM 好了它才撤,网页挂着这张的话那时已经画上)。
// 各端编一份生成副本(网页:mafold-web/scripts/sync-shared.mjs;桌面:mafold-desktop/
// scripts/sync-shared.mjs),改这里。
//
// 显不显示、深还是浅,由页面打标记,这里只认标记:<html> 上 data-boot="on"
// (或 "late" —— 到时间了自己淡出,见 lateMs)时显示;<body> 上
// data-theme="dark",或者没写而系统是深色时,用深色底。整页就是这一帧的页面
// (桌面那层)把这两个标记直接写进自己的标签里。
//
// 底色是 App 的(client-shared/appGround.ts),由画它的一方传进来:这个文件
// 自己不带任何底色。
//
// 不 import 任何东西:这个文件按原样拷进各端。

export const LOADING_FRAME = {
  /** 元素的 id,也是它的 class 和 keyframes 的前缀。 */
  id: "mf-boot",
  /** 盖过页面上的一切(新手引导那层是 2147482000)。 */
  z: 2147483000,
  icon: {
    /** CSS px,窗口正中。 */
    size: 88,
    radius: 20,
    shadow: "0 8px 28px rgba(0,0,0,.14),0 0 0 .5px rgba(0,0,0,.06)",
    /** 从 mafold-web/public/mafold-icon.png(1024px、1.1MB)缩出来的
     *  264px JPEG(size 的 3 倍),12KB。换图就换名字:它是永久缓存的
     *  (mafold-web/public/_headers)。手机画的是同一张图的同一份字节,内嵌成
     *  data URI(client-shared/loadingIcon.ts —— OTA 包里新加的图片文件是空白的)。 */
    src: "/mafold-boot-v1.jpg",
    px: 264,
  },
  /** 安卓 12 起系统自己先出一张启动屏:底色上正中一颗图标,系统一定把它裁成
   *  直径 `circle`(dp)的圆。手机的加载画面接它的那一帧先按这个圆摆,`ms` 里沿
   *  `ease.move` 缩成上面的 88、圆角 20 —— 不从圆一下跳成方块。从 API `api` 起;
   *  减少动态效果时不缩、直接换成方块(冷启动那一刻系统设置还没读回来,第一帧
   *  照样是圆,读回来那一刻当场换)。 */
  androidSplash: { circle: 160, ms: 200, api: 31 },
  /** 退场时图标落到哪:活动中心徽章里的那颗标 —— 缩到自己的 30/88,
   *  圆角(缩放前)23.5。 */
  badge: { scale: 30 / 88, radius: 23.5 },
  /** 在图标下面,离图标下沿 `gap`。过了 `delayMs` 才淡入,本来就快的加载
   *  永远看不到它(网页门口 DoorWait 的老规矩);`outMs` 是画面开始退场时
   *  它淡掉的时长。 */
  spinner: {
    size: 22,
    ring: 2,
    gap: 32,
    /** 轨道:次要文字色的 `trackPct`%,读转圈所在那一层的 --jTextMuted —— 门口 DoorWait
     *  在 .mafold-app 里,用的就是 App 的;加载画面不在 .mafold-app 里,由 #mf-boot
     *  按深浅色自己给(`muted`)。手机没有 color-mix,拿 App 的次要文字色按这个比例
     *  算出半透明色。 */
    trackPct: 30,
    /** 头:强调色,读 <html> 上那一层的 --mf-accent(App 的 applyAccent 写在那儿,
     *  加载画面拉起时第一帧前的阻塞脚本先写好),兜底是 App 的默认强调色
     *  DEFAULT_ACCENT(mafold-web 的 lib/accent.ts;loadingFrame.spec 钉着)。 */
    head: "var(--mf-accent,#2ea06b)",
    /** 加载画面上的 --jTextMuted,浅 / 深:跟 globals.css 里 .mafold-app 的一样
     *  (loadingFrame.spec 钉着)。 */
    muted: { light: "#6e6e73", dark: "#9a9aa0" },
    delayMs: 400,
    inMs: 200,
    turnMs: 800,
    outMs: 120,
  },
  /** 从徽章里出来(刷新时盖上):图标沿 `ease.move` 放大到正中,底色沿 `ease.fade` 淡入。 */
  enter: { iconMs: 520, groundMs: 320, groundDelayMs: 60 },
  /** 回到徽章里:图标沿 `ease.move`,底色沿 `ease.fade`。第一屏挂上以后,登着的人还要
   *  等聊天列表第一屏才退场(落地时底下该是列表,不是一张空表)—— 最多再等 `listWaitMs`。
   *  网页(MafoldApp 的 Screens)和手机(mafold-rn 的 lib/bootCurtain.ts)等的是同一个数。 */
  exit: { iconMs: 560, groundMs: 380, groundDelayMs: 150, listWaitMs: 1200 },
  ease: { move: "cubic-bezier(.32,.72,0,1)", fade: "cubic-bezier(.2,.7,.3,1)" },
  /** 原地淡出:没有徽章可飞、减少动态效果、到时间了。 */
  fadeMs: 200,
  /** 到这时还没人收,就自己淡掉(data-boot="late")。 */
  lateMs: 20000,
} as const;

/** 它站在哪两种底色上 —— appGround.ts 的浅色和深色。 */
export type LoadingGround = { readonly light: string; readonly dark: string };

/** 转圈本身:规则、keyframes、减少动态效果时的规则。加载画面和网页门口的
 *  DoorWait 共用这一个(400ms 后才淡入)。App 里面的转圈还不是它:ui.tsx 的
 *  Spinner 是另画的 SVG,globals.css 里也还有 mf-spin、mf-draft-spinner、
 *  gg-spin 几套 —— 那些要并过来是另一件事。 */
export function loadingSpinnerCss(selector: string, name: string): string {
  const s = LOADING_FRAME.spinner;
  const fadeIn = `${name}-in ${s.inMs}ms ease-out ${s.delayMs}ms forwards`;
  const track = `color-mix(in srgb,var(--jTextMuted,${s.muted.light}) ${s.trackPct}%,transparent)`;
  return [
    `${selector}{box-sizing:border-box;width:${s.size}px;height:${s.size}px;border-radius:50%;border:${s.ring}px solid ${track};border-top-color:${s.head};opacity:0;animation:${fadeIn},${name} ${s.turnMs}ms linear infinite}`,
    `@keyframes ${name}-in{to{opacity:1}}`,
    `@keyframes ${name}{to{transform:rotate(360deg)}}`,
    // 减少动态效果:照样告诉人「在加载」,只是不转。
    `@media (prefers-reduced-motion:reduce){${selector}{animation:${fadeIn}}}`,
  ].join("\n");
}

/** 页面挂上这一帧要的东西:样式表,和元素本身(`html`);自己写元素的页面
 *  只要里面那部分(`inner`)。 */
export function loadingFrame(ground: LoadingGround, icon: string = LOADING_FRAME.icon.src): { css: string; html: string; inner: string } {
  const f = LOADING_FRAME;
  const i = f.icon;
  const s = f.spinner;
  const el = `#${f.id}`;
  /** 画面挂着时的 `sub`。 */
  const up = (sub: string) => `html[data-boot="on"] ${el}${sub},html[data-boot="late"] ${el}${sub}`;
  const css = [
    // 收着时根本不是一个盒子 —— display:none,不是透明的一层:桌面版里任何带
    // app-region 的盒子都能拖窗,不管它透明不透明。挂着时不接点击(点下去的
    // 是底下的页面),在桌面版里拖它就是拖窗。
    // 深浅色跟着底色一起换的还有转圈轨道用的 --jTextMuted(它不在 .mafold-app 里,
    // 拿不到 App 的那一个)。
    `${el}{display:none;position:fixed;inset:0;z-index:${f.z};pointer-events:none;-webkit-app-region:drag;background:${ground.light};--jTextMuted:${s.muted.light}}`,
    `${up("")}{display:block}`,
    `body[data-theme="dark"] ${el}{background:${ground.dark};--jTextMuted:${s.muted.dark}}`,
    `@media (prefers-color-scheme:dark){body:not([data-theme="light"]) ${el}{background:${ground.dark};--jTextMuted:${s.muted.dark}}}`,
    `html[data-boot="late"] ${el}{animation:${f.id}-out ${f.fadeMs}ms ease-out forwards}`,
    `@keyframes ${f.id}-out{to{opacity:0}}`,
    `${el} .${f.id}-icon{position:absolute;left:50%;top:50%;width:${i.size}px;height:${i.size}px;margin:${-i.size / 2}px 0 0 ${-i.size / 2}px;border-radius:${i.radius}px;box-shadow:${i.shadow};background:center/cover no-repeat}`,
    // 图只在画面挂着时才有:从不挂它的页面(没登录的落地页、爬虫)永远不会去下载。
    // 反过来,挂上时才开始取:在缓存里时随即出现,冷缓存时晚一个请求(底色先到)。
    `${up(` .${f.id}-icon`)}{background-image:url("${icon}")}`,
    `${el} .${f.id}-spin{position:absolute;left:50%;top:50%;margin:${i.size / 2 + s.gap}px 0 0 ${-s.size / 2}px}`,
    loadingSpinnerCss(`${el} .${f.id}-spin`, `${f.id}-spin`),
  ].join("\n");
  const inner = `<i class="${f.id}-icon"></i><i class="${f.id}-spin"></i>`;
  return { css, html: `<div id="${f.id}" aria-hidden="true">${inner}</div>`, inner };
}
