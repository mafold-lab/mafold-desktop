// An agent on a site tab (cap `site-agent`, src/main/siteAgent.ts), in the real
// shell: the person's yes in the shell's own dialog (answered by
// MAFOLD_DESKTOP_TEST_CONFIRM here), then looking, pressing and typing as real
// input, never into a password field, and the grant ending with the tab or the
// page's Stop. The fixture page plays the page, as in sites.spec.ts.

import { expect, test } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

const SITE_PARTITION = "persist:mafold-sites";
const AGENT = "opsdu:claude-code";

let origins: Origins;
let l: Launched;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.afterEach(async () => {
  await l?.app.close();
});

async function open(confirm: "yes" | "no" = "yes"): Promise<number> {
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_TEST_CONFIRM: confirm });
  await l.page.waitForSelector("#h");
  await l.page.evaluate(
    (a) => {
      const w = document.createElement("webview");
      w.setAttribute("src", a.src);
      w.setAttribute("partition", a.partition);
      w.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px;display:flex";
      document.body.append(w);
      const said: unknown[] = [];
      (window as unknown as { __agent: unknown[] }).__agent = said;
      (window as unknown as { mafoldHost: { on(n: string, cb: (e: unknown) => void): void } }).mafoldHost.on("site-agent", (e) => said.push(e));
    },
    { src: `${origins.api}/agent-site`, partition: SITE_PARTITION },
  );
  await expect.poll(() => guestUrl()).toContain("/agent-site");
  await expect.poll(() => run("document.readyState")).toBe("complete");
  return l.page.evaluate(() => (document.querySelector("webview") as unknown as { getWebContentsId(): number }).getWebContentsId());
}

const guestUrl = () =>
  l.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === "webview")?.getURL() ?? "");

const run = <T = unknown>(js: string): Promise<T> =>
  l.app.evaluate(
    ({ webContents }, code) => webContents.getAllWebContents().find((w) => w.getType() === "webview")!.mainFrame.executeJavaScript(code),
    js,
  ) as Promise<T>;

type Host = {
  grant(tab: number, agent: string): Promise<string | null>;
  end(g: string): void;
  look(g: string, shot?: boolean): Promise<{ url: string; title: string; w: number; items: Array<{ ref: string; role: string; name: string; x: number; y: number; w: number; h: number; off?: boolean }>; text: string; shot?: string } | null>;
  locate(g: string, ref: string): Promise<{ x: number; y: number; w: number; h: number } | null>;
  act(g: string, a: unknown): Promise<{ ok: boolean; error?: string }>;
};

/** Call the page's `mafoldHost.siteAgent.<method>(...args)`. */
const sa = <T>(method: keyof Host, ...args: unknown[]): Promise<T> =>
  l.page.evaluate(
    ([m, a]) => ((window as unknown as { mafoldHost: { siteAgent: Record<string, (...x: unknown[]) => unknown> } }).mafoldHost.siteAgent[m as string](...(a as unknown[])) as Promise<unknown>),
    [method, args] as const,
  ) as Promise<T>;

const events = () => l.page.evaluate(() => (window as unknown as { __agent: Array<{ grant: string; kind: string }> }).__agent.slice());

/** Press where a thing is, as the agent does: locate, then a click at its middle. */
async function press(grant: string, target: string): Promise<{ ok: boolean; error?: string }> {
  const box = await sa<{ x: number; y: number; w: number; h: number } | null>("locate", grant, target);
  expect(box, `locate ${target}`).not.toBeNull();
  return sa("act", grant, { click: { x: box!.x + box!.w / 2, y: box!.y + box!.h / 2 } });
}

test("the page offers it by capability", async () => {
  await open();
  const caps = await l.page.evaluate(() => (window as unknown as { mafoldHost: { caps: string[]; siteAgent?: unknown } }).mafoldHost.caps);
  expect(caps).toContain("site-agent");
  expect(await l.page.evaluate(() => typeof (window as unknown as { mafoldHost: { siteAgent?: unknown } }).mafoldHost.siteAgent)).toBe("object");
});

test("a yes lets the agent look, press, type and scroll, with real input", async () => {
  const tab = await open();
  const grant = await sa<string | null>("grant", tab, AGENT);
  expect(grant).toMatch(/^[0-9a-f-]{36}$/);

  const look = await sa<Awaited<ReturnType<Host["look"]>>>("look", grant);
  expect(look!.url).toContain("/agent-site");
  expect(look!.text).toContain("Play with me");
  const names = look!.items.map((i) => `${i.role} ${i.name}`);
  expect(names).toContain("button Press me");
  expect(names).toContain("text Your name");
  expect(names).toContain("password Password");
  expect(look!.items.find((i) => i.name === "Far down")?.off).toBe(true);
  expect(look!.shot).toBeUndefined();

  // By ref, and by the words on it: a real press (isTrusted), not the agent's
  // own input counted as the person's.
  const ref = look!.items.find((i) => i.name === "Press me")!.ref;
  expect(await press(grant!, ref)).toEqual({ ok: true });
  await expect.poll(() => run("window.__pressed")).toBe(1);
  expect(await run("document.getElementById('press').dataset.trusted")).toBe("true");
  expect(await press(grant!, "Press me")).toEqual({ ok: true });
  await expect.poll(() => run("window.__pressed")).toBe(2);

  expect(await press(grant!, "Your name")).toEqual({ ok: true });
  expect(await sa("act", grant, { type: "hello" })).toEqual({ ok: true });
  await expect.poll(() => run("document.getElementById('name').value")).toBe("hello");
  expect(await sa("act", grant, { key: "Backspace" })).toEqual({ ok: true });
  await expect.poll(() => run("document.getElementById('name').value")).toBe("hell");

  expect(await sa("act", grant, { scroll: 800 })).toEqual({ ok: true });
  await expect.poll(() => run<number>("scrollY")).toBeGreaterThan(0);

  // A thing out of view is brought into it before it is pressed.
  const far = await sa<{ y: number; h: number } | null>("locate", grant, "Far down");
  expect(far!.y).toBeGreaterThanOrEqual(0);
  expect(far!.y + far!.h).toBeLessThanOrEqual(480);

  // A picture only when asked, small enough to travel.
  const shot = await sa<Awaited<ReturnType<Host["look"]>>>("look", grant, true);
  expect(shot!.shot).toMatch(/^data:image\/jpeg;base64,/);
  expect(shot!.shot!.length).toBeLessThan(120_000);

  await l.page.waitForTimeout(400);
  expect((await events()).filter((e) => e.kind === "input")).toEqual([]);
});

test("never a password field: not typed into, not read", async () => {
  const tab = await open();
  const grant = await sa<string>("grant", tab, AGENT);
  await run("document.getElementById('secret').value = 'hunter2'");
  const look = await sa<Awaited<ReturnType<Host["look"]>>>("look", grant);
  expect(JSON.stringify(look)).not.toContain("hunter2");
  expect(await press(grant, "Password")).toEqual({ ok: true });
  expect(await sa("act", grant, { type: "x" })).toEqual({ ok: false, error: "password" });
  expect(await sa("act", grant, { key: "Backspace" })).toEqual({ ok: false, error: "password" });
  expect(await run("document.getElementById('secret').value")).toBe("hunter2");
});

test("the person's own press is news; the grant ends with Stop, and with the tab", async () => {
  const tab = await open();
  const grant = await sa<string>("grant", tab, AGENT);
  await l.page.waitForTimeout(300);
  const at = await run<{ x: number; y: number }>("(() => { const r = document.getElementById('press').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()");
  await l.app.evaluate(({ webContents }, a) => {
    const w = webContents.getAllWebContents().find((c) => c.getType() === "webview")!;
    const send = Object.getPrototypeOf(w).sendInputEvent.bind(w) as Electron.WebContents["sendInputEvent"];
    send({ type: "mouseDown", x: a.x, y: a.y, button: "left", clickCount: 1 });
    send({ type: "mouseUp", x: a.x, y: a.y, button: "left", clickCount: 1 });
  }, at);
  await expect.poll(async () => (await events()).filter((e) => e.kind === "input" && e.grant === grant).length).toBeGreaterThan(0);

  await l.page.evaluate((g) => (window as unknown as { mafoldHost: { siteAgent: { end(g: string): void } } }).mafoldHost.siteAgent.end(g), grant);
  await expect.poll(async () => (await events()).some((e) => e.kind === "ended" && e.grant === grant)).toBe(true);
  expect(await sa("look", grant)).toBeNull();
  expect(await sa("act", grant, { scroll: 100 })).toEqual({ ok: false, error: "ended" });

  // A new yes, then the tab goes.
  await l.page.waitForTimeout(1600);
  const again = await sa<string>("grant", tab, AGENT);
  expect(again).toBeTruthy();
  await l.page.evaluate(() => document.querySelector("webview")?.remove());
  await expect.poll(async () => (await events()).some((e) => e.kind === "ended" && e.grant === again)).toBe(true);
});

test("a no, a tab that isn't a site of the page, and an address the tab wouldn't open get nothing", async () => {
  const tab = await open("no");
  expect(await sa("grant", tab, AGENT)).toBeNull();
  expect(await sa("grant", 999_999, AGENT)).toBeNull();
  // The page itself is not a site.
  const pageId = await l.app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() !== "webview" && w.getURL().includes("127.0.0.1"))!.id);
  expect(await sa("grant", pageId, AGENT)).toBeNull();
  expect(await sa("grant", tab, "not a username!")).toBeNull();
});

test("goto goes by the tab's rules", async () => {
  const tab = await open();
  const grant = await sa<string>("grant", tab, AGENT);
  expect(await sa("act", grant, { goto: `${origins.api}/titled` })).toEqual({ ok: true });
  await expect.poll(() => guestUrl()).toContain("/titled");
  expect(await sa("act", grant, { goto: "file:///etc/passwd" })).toEqual({ ok: false, error: "refused" });
  expect(await sa("act", grant, { goto: "javascript:alert(1)" })).toEqual({ ok: false, error: "refused" });
  expect(await sa("act", grant, { click: { x: 1, y: 1 }, type: "two at once" })).toEqual({ ok: false, error: "refused" });
});
