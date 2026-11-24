// A conversation's window folding into its row in the main window, and growing
// out of it (ops 11-24, `chat-window-fold`). What moves is a still of the
// window in a see-through window of its own, over everything: the real one
// never changes size, so its page never reflows on the way. Going, the still
// fades to a plain panel of the page's ground before it reaches the row and
// goes; coming, the panel grows, the window shows under it once it has
// painted, and it goes.

import { BrowserWindow, systemPreferences, type NativeImage, type Rectangle } from "electron";

import { log } from "./log";

/** Long enough to follow into the row, short enough not to wait for. */
export const FOLD_MS = 380;
export const GROW_MS = 320;
/** The row's own corner; the window's is `fromRadius`. */
export const ROW_RADIUS = 12;
/** Room around the path for the still's shadow. */
const PAD = 48;

export interface Flight {
  from: Rectangle;
  to: Rectangle;
  ms: number;
  /** "fold": the still fades out on the way, then the panel; "grow": the panel
   *  grows and stays at `to` until `landed` (the window under it painted). */
  kind: "fold" | "grow";
  fromRadius: number;
  toRadius: number;
  ground: string;
  /** The macOS curve on the window's end (`corner-shape`, see WINDOW_CORNER). */
  squircle: boolean;
}

/** Reduced motion asked for: things go and come without moving. */
export function stillMotion(): boolean {
  try {
    return process.platform === "darwin" ? systemPreferences.getAnimationSettings().prefersReducedMotion : false;
  } catch {
    return false;
  }
}

const union = (a: Rectangle, b: Rectangle): Rectangle => {
  const x = Math.floor(Math.min(a.x, b.x) - PAD);
  const y = Math.floor(Math.min(a.y, b.y) - PAD);
  return { x, y, width: Math.ceil(Math.max(a.x + a.width, b.x + b.width) + PAD) - x, height: Math.ceil(Math.max(a.y + a.height, b.y + b.height) + PAD) - y };
};

// The page plays the whole flight itself (one Web Animation), so nothing
// crosses the bridge per frame. `fly` resolves when it has landed.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
#g{position:absolute;overflow:hidden;box-sizing:border-box}
#g img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;object-position:left top}
</style><div id="g"><img alt=""></div><script>
let f, shot;
const box = (r, radius) => ({ left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px", borderRadius: radius + "px" });
// The first frame, still image and all, before the window shows: no blink.
window.prep = (flight, still) => new Promise((done) => {
  f = flight; shot = still;
  const g = document.getElementById("g"), img = g.querySelector("img");
  Object.assign(g.style, box(f.from, f.fromRadius), { background: f.ground });
  if (f.squircle) g.style.cornerShape = "squircle";
  if (!shot) { img.remove(); return done(); }
  if (f.kind === "grow") img.style.opacity = "0";
  img.onload = img.onerror = () => done();
  img.src = shot;
});
window.fly = () => new Promise((done) => {
  const g = document.getElementById("g"), img = g.querySelector("img");
  const a = box(f.from, f.fromRadius), b = box(f.to, f.toRadius);
  const shade = "0 18px 48px rgba(0,0,0,.28)", none = "0 0 0 rgba(0,0,0,0)";
  if (f.kind === "fold") {
    if (shot) img.animate([{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }], { duration: f.ms, fill: "forwards" });
    g.animate([{ ...a, opacity: 1, boxShadow: shade }, { ...b, opacity: 0.85, boxShadow: none, offset: 0.88 }, { ...b, opacity: 0, boxShadow: none }], { duration: f.ms, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" }).finished.then(() => done());
  } else {
    if (shot) img.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: f.ms, fill: "forwards" });
    g.animate([{ ...a, opacity: 0.4, boxShadow: none }, { ...b, opacity: 1, boxShadow: shade }], { duration: f.ms, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished.then(() => done());
  }
});
</script>`;

/** A flight, ready: shown at its first frame with `show`, played with `play`,
 *  gone with `close`. Null when the window for it couldn't be made. */
export interface Ghost {
  show(): void;
  play(): Promise<void>;
  close(): void;
}

export async function ghost(f: Flight, shot: NativeImage | null): Promise<Ghost | null> {
  const area = union(f.from, f.to);
  const local = (r: Rectangle): Rectangle => ({ x: r.x - area.x, y: r.y - area.y, width: r.width, height: r.height });
  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      ...area,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      backgroundColor: "#00000000",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
  } catch (e) {
    log("chat window flight failed:", e);
    return null;
  }
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "floating");
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  } catch (e) {
    log("chat window flight failed:", e);
    if (!win.isDestroyed()) win.destroy();
    return null;
  }
  // At the window's size, not the screen's: a still that only shrinks needs no more.
  const img = shot && !shot.isEmpty() ? `data:image/jpeg;base64,${shot.resize({ width: Math.round(f.kind === "fold" ? f.from.width : f.to.width) }).toJPEG(82).toString("base64")}` : null;
  const flight = { ...f, from: local(f.from), to: local(f.to) };
  await win.webContents.executeJavaScript(`window.prep(${JSON.stringify(flight)}, ${JSON.stringify(img)})`).catch(() => {});
  return {
    show: () => {
      if (!win.isDestroyed()) win.showInactive();
    },
    play: () => (win.isDestroyed() ? Promise.resolve() : win.webContents.executeJavaScript("window.fly()").then(() => {}, () => {})),
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
