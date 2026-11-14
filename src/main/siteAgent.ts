// An agent using one site tab (cap `site-agent`): the person says yes in the
// shell's own dialog, then the shell reads that tab and acts in it with real
// input for the page, which draws the agent's cursor and passes the agent's
// steps along (mafold-web lib/agentTabs.ts). The page can't do any of this to a
// site by itself — the tag's methods are sealed (sites.ts) — and a card runs in
// the page's realm, so everything the page asks for here is checked again:
// the tab must be a site on the main window's page, the grant must be live,
// and the keyboard must not be in a password field.

import { dialog, session as electronSession, webContents as electronWebContents, type WebContents } from "electron";

import { RateLimit } from "./limits";
import { log } from "./log";
import { decideSiteNavigation, originOf } from "./policy";
import type { Shell } from "./shell";
import { unsealed } from "./sites";
import { SITE_INCOGNITO_PARTITION, SITE_PARTITION, type SiteAgentAct, type SiteAgentActResult, type SiteAgentBox, type SiteAgentKey, type SiteAgentLook } from "../shared/desktopHost.generated";

/** The scripts run in a world of their own: the site's scripts can't see the
 *  refs, or replace what the scripts call. */
const WORLD = 1999;
/** The person's own input in the tab this soon after the agent's is the
 *  agent's still (the input path reports both the same way). */
const OWN_ECHO_MS = 250;
/** How wide a `shot` is at most, and how it is squeezed: it travels to the
 *  agent inside a message's state, which holds 64 KB a person. */
const SHOT_WIDTH = 720;
const SHOT_QUALITY = 55;

const KEY_CODES: Record<SiteAgentKey, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Space: "Space",
};

/** What can be acted on, read in the site's own document. Refs stay in the
 *  world's `__mfRefs` for `locate`. A password field says it is one, never
 *  what is in it. */
export const LOOK_SCRIPT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const vw = innerWidth, vh = innerHeight, refs = new Map(), items = [];
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < -vh || r.top > vh * 3 || r.right < 0 || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const tag = el.tagName;
    const pw = tag === "INPUT" && el.type === "password";
    const role = el.getAttribute("role") || (tag === "A" ? "link" : tag === "BUTTON" ? "button" : tag === "INPUT" ? (pw ? "password" : el.type || "text") : tag === "SELECT" ? "select" : tag === "TEXTAREA" ? "textbox" : tag === "SUMMARY" ? "summary" : "clickable");
    const said = el.getAttribute("aria-label") || el.getAttribute("title") || (pw ? "" : el.innerText) || el.getAttribute("placeholder") || el.getAttribute("alt") || "";
    const value = !pw && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && el.value ? " = " + clean(el.value) : "";
    const ref = "e" + (refs.size + 1);
    refs.set(ref, el);
    const item = { ref, role, name: clean(said) + value, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (r.bottom < 0 || r.top > vh) item.off = true;
    items.push(item);
    if (items.length >= 300) break;
  }
  window.__mfRefs = refs;
  const text = (document.body ? document.body.innerText : "").replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n").slice(0, 4000);
  return { url: location.href, title: document.title, w: vw, h: vh, items, text };
})()`;

/** A thing from the last look, or the first whose words match: scrolled into
 *  view, and where it is now. */
export const locateScript = (ref: string): string => `(() => {
  const want = ${JSON.stringify(ref)}, refs = window.__mfRefs || new Map();
  let el = refs.get(want);
  if (!el || !el.isConnected) {
    const said = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText || e.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim();
    const all = [...refs.values()].filter((e) => e.isConnected);
    el = all.find((e) => said(e) === want) || all.find((e) => said(e).startsWith(want + " ")) || all.find((e) => said(e).includes(want));
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

/** Whether the keyboard is in a password field of this frame. */
const PASSWORD_SCRIPT = `(() => { const a = document.activeElement; return !!(a && document.hasFocus() && a.tagName === "INPUT" && a.type === "password"); })()`;

interface Grant {
  contents: WebContents;
  agent: string;
  /** Until when the person's input is the agent's own (OWN_ECHO_MS). */
  ownUntil: number;
}

export class SiteAgents {
  private grants = new Map<string, Grant>();
  private asking = false;
  private asks = new RateLimit(1500);

  constructor(
    private shell: Shell,
    private confirm: (agent: string, site: string) => Promise<boolean>,
  ) {}

  /** A site on a tab of the main window's page, or nothing. */
  private site(tab: number): WebContents | null {
    const c = electronWebContents.fromId(tab);
    if (!c || c.isDestroyed() || c.getType() !== "webview") return null;
    const page = this.shell.page;
    if (!page || c.hostWebContents !== page) return null;
    const ours = [SITE_PARTITION, SITE_INCOGNITO_PARTITION].some((p) => c.session === electronSession.fromPartition(p));
    return ours ? c : null;
  }

  private live(id: string): Grant | null {
    const g = this.grants.get(id);
    if (!g) return null;
    if (g.contents.isDestroyed()) {
      this.drop(id);
      return null;
    }
    return g;
  }

  async grant(tab: number, agent: string): Promise<string | null> {
    const contents = this.site(tab);
    if (!contents) return null;
    // One question at a time, and not one after another: a card can ask too.
    if (this.asking || !this.asks.allow("grant", Date.now())) return null;
    for (const [id, g] of this.grants) if (g.contents === contents && g.agent === agent) return id;
    const origin = originOf(contents.getURL());
    const site = origin ? new URL(origin).host : contents.getURL().slice(0, 80);
    this.asking = true;
    let yes = false;
    try {
      yes = await this.confirm(agent, site);
    } finally {
      this.asking = false;
    }
    if (!yes || contents.isDestroyed()) return null;
    const id = crypto.randomUUID();
    this.grants.set(id, { contents, agent, ownUntil: 0 });
    contents.once("destroyed", () => this.drop(id));
    log("site agent granted:", agent, site);
    return id;
  }

  end(id: string): void {
    if (this.grants.has(id)) this.drop(id);
  }

  /** The page stopped listening (it reloaded, or went): nobody draws the
   *  agent or its Stop any more, so nothing it was granted stays. */
  endAll(): void {
    for (const id of [...this.grants.keys()]) this.drop(id);
  }

  private drop(id: string): void {
    this.grants.delete(id);
    this.shell.emit("site-agent", JSON.stringify({ grant: id, kind: "ended" }));
  }

  /** The person pressed something in a site: news to whoever uses that tab. */
  input(contents: WebContents): void {
    const now = Date.now();
    for (const [id, g] of this.grants) {
      if (g.contents !== contents || now < g.ownUntil) continue;
      this.shell.emit("site-agent", JSON.stringify({ grant: id, kind: "input" }));
    }
  }

  async look(id: string, shot: boolean): Promise<SiteAgentLook | null> {
    const g = this.live(id);
    if (!g) return null;
    const real = unsealed(g.contents);
    const seen = (await real.executeJavaScriptInIsolatedWorld(WORLD, [{ code: LOOK_SCRIPT }])) as SiteAgentLook;
    if (!seen || typeof seen !== "object") return null;
    if (shot) {
      const img = await real.capturePage();
      const size = img.getSize();
      const small = size.width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: "good" }) : img;
      seen.shot = `data:image/jpeg;base64,${small.toJPEG(SHOT_QUALITY).toString("base64")}`;
    }
    return seen;
  }

  async locate(id: string, ref: string): Promise<SiteAgentBox | null> {
    const g = this.live(id);
    if (!g) return null;
    const box = (await unsealed(g.contents).executeJavaScriptInIsolatedWorld(WORLD, [{ code: locateScript(ref) }])) as SiteAgentBox | null;
    return box && typeof box.x === "number" ? box : null;
  }

  async act(id: string, act: SiteAgentAct): Promise<SiteAgentActResult> {
    const g = this.live(id);
    if (!g) return { ok: false, error: "ended" };
    const c = g.contents;
    const real = unsealed(c);
    const own = () => {
      g.ownUntil = Date.now() + OWN_ECHO_MS;
    };
    try {
      if ("click" in act) {
        const { x, y } = act.click;
        own();
        c.focus();
        real.sendInputEvent({ type: "mouseMove", x, y });
        real.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        real.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        own();
      } else if ("type" in act) {
        if (await this.inPassword(c)) return { ok: false, error: "password" };
        own();
        await real.insertText(act.type);
        own();
      } else if ("key" in act) {
        if (await this.inPassword(c)) return { ok: false, error: "password" };
        const keyCode = KEY_CODES[act.key];
        own();
        real.sendInputEvent({ type: "keyDown", keyCode });
        if (act.key === "Enter") real.sendInputEvent({ type: "char", keyCode: "\r" });
        real.sendInputEvent({ type: "keyUp", keyCode });
        own();
      } else if ("scroll" in act) {
        const [w, h] = await real.executeJavaScriptInIsolatedWorld(WORLD, [{ code: "[innerWidth, innerHeight]" }]) as [number, number];
        own();
        // Chromium's wheel: a negative delta moves the page down.
        real.sendInputEvent({ type: "mouseWheel", x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: -act.scroll, canScroll: true });
        own();
      } else {
        if (decideSiteNavigation(act.goto) !== "allow") return { ok: false, error: "refused" };
        own();
        await c.loadURL(act.goto).catch(() => undefined);
      }
      return { ok: true };
    } catch (err) {
      log("site agent act failed:", String(err));
      return { ok: false, error: "failed" };
    }
  }

  /** The keyboard in a password field of any frame of the site. A frame that
   *  can't say counts as one: nothing is typed on a guess. */
  private async inPassword(c: WebContents): Promise<boolean> {
    for (const frame of c.mainFrame.framesInSubtree) {
      try {
        if (await frame.executeJavaScript(PASSWORD_SCRIPT)) return true;
      } catch {
        if (frame === c.mainFrame) return true;
      }
    }
    return false;
  }
}

/** The shell's own dialog: its words, not the page's (`frozen`). */
export function siteAgentConfirm(shell: Shell): (agent: string, site: string) => Promise<boolean> {
  return async (agent, site) => {
    const test = shell.cfg.test?.confirm;
    if (test) return test === "yes";
    const f = (k: string) => shell.strings.frozen(k, { agent: `@${agent}`, site });
    shell.showWindow();
    const options = {
      type: "question" as const,
      message: f("desktop.siteAgent.ask"),
      detail: f("desktop.siteAgent.detail"),
      buttons: [f("desktop.siteAgent.allow"), f("desktop.siteAgent.deny")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const win = shell.window;
    const r = await (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
    return r.response === 0;
  };
}
