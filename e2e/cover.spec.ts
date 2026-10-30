// 开窗先画加载画面 —— 更新胶囊 D5。
//
// 以前窗口建好先藏着(show:false),等网页第一帧(ready-to-show)才出来:网络慢时
// 点了图标好几秒什么都没有。现在窗口当场出来,上面盖一层只放静止画面的子视图
// (src/main/cover.ts):跟网页第一帧是同一张(client-shared/loadingFrame.ts 的生成
// 副本),站在 App 的底色上;网页 DOM 好了再撤,撤了就把那层关掉。不是「先开一张本地
// 页再跳网页」:后退记录里只有网页那一条。离线页照旧,不会卡在盖层底下。
//
// 慢页:fixture 的 `?slow=<ms>`(fixtures.ts),由 MAFOLD_DESKTOP_START_PATH 打开。
// 拖窗(盖层自己声明 app-region: drag)在 Linux / CI 上看不了,要 macOS 真机。

import { writeFileSync } from "node:fs";

import { expect, test, type ElectronApplication } from "@playwright/test";

import { APP_GROUND } from "../src/shared/appGround.generated";
import { loadingFrame } from "../src/shared/loadingFrame.generated";
import { LOADING_ICON_URI } from "../src/shared/loadingIcon.generated";
import { launch, mainPage, start, startOrigins, type Origins } from "./fixtures";

const HIDDEN_ARG = "--hidden"; // autostart.ts(它 import electron,这里加载不了)

type Rect = { x: number; y: number; width: number; height: number };
type Hooks = { coverUp(): boolean; coverBounds(): Rect | null };
type Scheme = "light" | "dark";

/** 窗口出来了没有、盖层在不在。壳刚起、测试钩子还没装上时 cover 是 null。 */
const state = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const h = (globalThis as unknown as { __mafoldTest?: Hooks }).__mafoldTest;
    return { shown: !!w && w.isVisible(), cover: h ? h.coverUp() : null };
  });

/** 盖层盖满了窗口的内容区就是 "fills";不然把两边的尺寸交出来看。 */
const coverFit = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const [width, height] = BrowserWindow.getAllWindows()[0].getContentSize();
    const b = (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.coverBounds();
    return b && b.x === 0 && b.y === 0 && b.width === width && b.height === height ? "fills" : { cover: b, content: [width, height] };
  });

const contentSize = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());

/** 主窗口上挂着几层子视图。BrowserWindow 的 contentView 本身就是页面那层,盖层是挂在
 *  它上面的唯一一层:盖着是 1,撤了是 0。coverUp() 只是壳自己记的账(撤的第一步就清),
 *  这个看的是窗口的视图树里那一层真拿没拿下来。 */
const coverViews = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length);

/** 键盘焦点在哪:窗口本身、主窗口的页面、盖层(没有盖层时 null)。 */
const focus = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow, webContents }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const c = webContents.getAllWebContents().find((x) => x.getURL().startsWith("data:"));
    return { window: w.isFocused(), page: w.webContents.isFocused(), cover: c ? c.isFocused() : null };
  });

/** 壳里现在所有 web contents 的地址(data: 的只留开头)。 */
const contents = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => (w.getURL().startsWith("data:") ? "data:…" : w.getURL())));

/** 盖层装的那份文档:它的 data: URL 解出来;没有盖层就是 null。 */
const coverDocument = async (app: ElectronApplication): Promise<string | null> => {
  const url = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("data:"))?.getURL() ?? null);
  if (!url) return null;
  const comma = url.indexOf(",");
  const body = url.slice(comma + 1);
  return url.slice(0, comma).endsWith(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
};

/** 盖层拍下来的样子:离图标远的一点(左下,该是底色)、图标里的一点(正中往右下
 *  30px,图标是 88px —— 该是图标的颜色,不是底色),和整张 PNG。BGRA。
 *  那层还没交出第一帧时拍不到:capturePage 会抛(xvfb 上见过 UnknownVizError)、
 *  给一张空图,或者干脆不回(xvfb 上见过,第一次拍就挂住 5 秒)—— 一律交回
 *  `{ error }`,外面的 poll 接着等(poll 的回调自己抛错是当场失败、自己不回是等到
 *  超时,都不重试)。拍之前先 invalidate():那层画面静止不动,逼它重画一帧给拍。
 *  `{ error }` 带着那层的样子(渲染进程崩了没有、还在不在加载、进程号、主窗口
 *  看不看得见):ubuntu 上 45 回里有 3 回整整 5 秒都拍不到(10-28「没回」、10-29 /
 *  10-30 UnknownVizError,都是整套里第一次起 Electron),只有一句错,分不出是那层
 *  没起来、崩了,还是起来了却一直不出帧。 */
const coverShot = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents, BrowserWindow }) => {
    const c = webContents.getAllWebContents().find((w) => w.getURL().startsWith("data:"));
    const b = (globalThis as unknown as { __mafoldTest: Hooks }).__mafoldTest.coverBounds();
    if (!c || !b) return { error: "no cover" };
    const why = (error: string) => ({
      error,
      crashed: c.isCrashed(),
      loading: c.isLoading(),
      pid: c.getOSProcessId(),
      windowShown: BrowserWindow.getAllWindows()[0]?.isVisible() ?? null,
    });
    c.invalidate();
    let img: Electron.NativeImage | null;
    try {
      img = await Promise.race([c.capturePage(), new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
    } catch (e) {
      return why(String(e));
    }
    if (!img) return why("capture did not answer in 1 s");
    if (img.isEmpty()) return why("empty capture");
    const { width, height } = img.getSize();
    const scale = width / b.width;
    const bmp = img.toBitmap();
    const px = (x: number, y: number) => {
      const i = (Math.round(y) * width + Math.round(x)) * 4;
      return [bmp[i + 2], bmp[i + 1], bmp[i]];
    };
    return { ground: px(width * 0.1, height * 0.9), icon: px(width / 2 + 30 * scale, height / 2 + 30 * scale), png: img.toPNG().toString("base64") };
  });

const scheme = (app: ElectronApplication) => app.evaluate(({ nativeTheme }): Scheme => (nativeTheme.shouldUseDarkColors ? "dark" : "light"));
const near = (rgb: number[], hex: string, tolerance: number) =>
  [1, 3, 5].every((k, i) => Math.abs(rgb[i] - Number.parseInt(hex.slice(k, k + 2), 16)) <= tolerance);

/** 主窗口的后退记录:几条、能不能后退。 */
const history = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const h = BrowserWindow.getAllWindows()[0].webContents.navigationHistory;
    return { length: h.length(), back: h.canGoBack() };
  });

let origins: Origins;
let app: ElectronApplication | null = null;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.afterEach(async () => {
  await app?.close();
  app = null;
});

test("页面还在路上:窗口当场出来,盖着网页第一帧那一张;页面到了盖层撤掉、关掉,后退记录只有一条", async () => {
  // 页面 15 秒后才到:下面拍盖层、改大小、点焦点都要在它到之前做完(拍不到要重拍)。
  const path = "/app?slow=15000";
  const s = await start(origins.web, origins.api, { MAFOLD_DESKTOP_START_PATH: path });
  app = s.app;

  // 从壳起来算(测试钩子装上的那一刻:index.ts 里同一步先建好主窗口、开始加载页面),
  // 不从进程起来算 —— macOS 的 CI 上第一次起 Electron(冷缓存)光到 ready 就过了 1 秒。
  await expect.poll(async () => (await state(s.app)).cover, { timeout: 8000 }).not.toBeNull();
  // 1 秒内:窗口看得见,盖层在(以前要等页面第一帧,这里页面 15 秒后才到)。
  await expect.poll(() => state(s.app), { timeout: 1000, intervals: [50] }).toEqual({ shown: true, cover: true });

  // 盖满窗口的内容区,是窗口上挂着的那一层子视图。
  await expect.poll(() => coverFit(s.app)).toBe("fills");
  expect(await coverViews(s.app)).toBe(1);

  // 画的是网页第一帧那一张:loadingFrame 生成副本的样式和元素、App 的两档底色、内嵌的那份图。
  // 那层的地址是它已提交的那份文档的:它的渲染进程刚起、还没提交时是空的(CI 上
  // macOS、Linux 都见过这时还没有),等它。
  const frame = loadingFrame(APP_GROUND, LOADING_ICON_URI);
  await expect.poll(() => coverDocument(s.app)).not.toBeNull();
  const doc = await coverDocument(s.app);
  expect(doc).toContain(frame.css);
  expect(doc).toContain(frame.html);
  expect(doc).toMatch(/<html[^>]*\sdata-boot="on"/);

  // 真画出来了:离图标远处是这会儿深浅色的 App 底色,正中是图标(图到了才算)。
  // 再换一次深浅色:盖层跟着换(那层页面的 prefers-color-scheme 跟壳的 nativeTheme 走)。
  const now = await scheme(s.app);
  for (const sch of [now, now === "dark" ? "light" : "dark"] as const) {
    if (sch !== now) await s.app.evaluate(({ nativeTheme }, m) => void (nativeTheme.themeSource = m), sch);
    const ground = APP_GROUND[sch];
    let png = "";
    await expect
      .poll(async () => {
        const shot = await coverShot(s.app);
        if ("error" in shot) return shot;
        png = shot.png;
        return { ground: near(shot.ground, ground, 10), icon: !near(shot.icon, ground, 40), at: { ground: shot.ground, icon: shot.icon } };
      })
      .toMatchObject({ ground: true, icon: true });
    writeFileSync(test.info().outputPath(`cover-loading-${sch}.png`), Buffer.from(png, "base64"));
  }
  await s.app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = "system"));

  // 窗口改大小,盖层跟着。
  const before = await contentSize(s.app);
  await s.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [width, height] = w.getContentSize();
    w.setContentSize(width - 40, height - 30);
  });
  await expect.poll(() => contentSize(s.app)).not.toEqual(before);
  await expect.poll(() => coverFit(s.app)).toBe("fills");

  // 盖着时点了窗口:键盘焦点落在盖层上(撤的时候要还给页面,见下面)。
  await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await expect.poll(() => focus(s.app)).toMatchObject({ window: true });
  await s.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith("data:"))?.focus());
  await expect.poll(() => focus(s.app)).toEqual({ window: true, page: false, cover: true });
  expect((await state(s.app)).cover).toBe(true); // 这一路都还是页面没到的时候

  // 页面到了:盖层从窗口的视图树上拿下来、那层也关了 —— 壳里只剩主窗口那一个 web
  // contents,Playwright 也只剩一个窗口;键盘焦点回到页面上。
  const page = await mainPage(s.app);
  await page.waitForSelector("#h");
  await expect.poll(() => state(s.app)).toEqual({ shown: true, cover: false });
  await expect.poll(() => coverViews(s.app)).toBe(0);
  await expect.poll(() => contents(s.app)).toEqual([`${origins.web}${path}`]);
  await expect.poll(() => s.app.windows().length).toBe(1);
  await expect.poll(() => focus(s.app)).toEqual({ window: true, page: true, cover: null });
  // 拍的是主窗口的页面自己(盖层那一层本来就拍不进去),给人看页面到了是什么样。
  await page.screenshot({ path: test.info().outputPath("cover-after.png") });

  // 没走「先开本地页再跳网页」:后退记录里只有网页这一条。
  expect(await history(s.app)).toEqual({ length: 1, back: false });
});

test("页面当场就到:盖层随即撤掉,只剩一个窗口、一条后退记录", async () => {
  const l = await launch(origins.web, origins.api);
  app = l.app;
  await l.page.waitForSelector("#h");
  await expect.poll(() => state(l.app)).toEqual({ shown: true, cover: false });
  await expect.poll(() => coverViews(l.app)).toBe(0);
  await expect.poll(() => contents(l.app)).toEqual([`${origins.web}/app`]);
  await expect.poll(() => l.app.windows().length).toBe(1);
  expect(await history(l.app)).toEqual({ length: 1, back: false });
});

test("网页源连不上:离线页出来,不卡在盖层底下", async () => {
  const l = await launch("http://127.0.0.1:9", origins.api);
  app = l.app;
  await l.page.waitForURL(/offline\.html/);
  await l.page.waitForSelector("#title");
  await expect.poll(() => state(l.app)).toEqual({ shown: true, cover: false });
  await expect.poll(() => coverViews(l.app)).toBe(0);
  await expect.poll(async () => (await contents(l.app)).some((u) => u.startsWith("data:"))).toBe(false);
});

test("开机在托盘里起(--hidden):窗口不出来,盖层照样盖着,页面到了照样撤", async () => {
  const s = await start(origins.web, origins.api, { MAFOLD_DESKTOP_START_PATH: "/app?slow=3000" }, [HIDDEN_ARG]);
  app = s.app;
  await expect.poll(() => state(s.app)).toEqual({ shown: false, cover: true });
  expect(await coverViews(s.app)).toBe(1);
  const page = await mainPage(s.app);
  await page.waitForSelector("#h");
  await expect.poll(() => state(s.app)).toEqual({ shown: false, cover: false });
  await expect.poll(() => coverViews(s.app)).toBe(0);
});
