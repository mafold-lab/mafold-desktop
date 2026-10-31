// The real window, as the OS has it — for e2e/phoneWidth.spec.ts: where it is
// on the screen, a picture of it the way the OS composites it (the page's
// lights included), a recording of the screen, and real mouse input.
//
// Everything here is best effort by design: a runner may not let a process
// record the screen or post input. Each helper says what happened — `ok`, or
// `notPermitted` with the system's words — and never throws for that; the spec
// writes it down and only fails on what the window itself did wrong.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ElectronApplication } from "@playwright/test";

export type Os = "macos" | "windows" | "linux";
export const OS: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Geometry {
  bounds: Rect;
  content: Rect;
  /** Where the page is, on screen: the content area, or (macOS, the phone
   *  layout) the part of it under the shell's own title bar (frame.ts). */
  page: Rect;
  area: Rect;
  scale: number;
  maximized: boolean;
  minimized: boolean;
}

export type Outcome =
  | { ok: true; file?: string; note?: string }
  | { ok: false; notPermitted: boolean; reason: string };

const notPermitted = (reason: string): Outcome => ({ ok: false, notPermitted: true, reason });

/** Run a program; resolve with its output, never reject (code !== 0 is data). */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 30_000, env: { ...process.env, ...opts.env }, maxBuffer: 8 << 20, windowsHide: true },
      (e, out, err) => resolve({ code: e ? ((e as NodeJS.ErrnoException & { code?: unknown }).code === "ENOENT" ? -1 : (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : 1)) : 0, out: String(out), err: String(err || (e ? e.message : "")) }),
    );
  });
}

/** The main window (the first BaseWindow: the page, its title bar on macOS and
 *  the loading cover are views in it). */
export function geometry(app: ElectronApplication): Promise<Geometry> {
  return app.evaluate(({ BaseWindow, screen }) => {
    const w = BaseWindow.getAllWindows()[0];
    const d = screen.getDisplayMatching(w.getBounds());
    const content = w.getContentBounds();
    type Frame = { page: { x: number; y: number; width: number; height: number } | null };
    const f = (globalThis as unknown as { __mafoldTest?: { frame?(): Frame | null } }).__mafoldTest?.frame?.()?.page;
    return {
      bounds: w.getBounds(),
      content,
      page: f ? { x: content.x + f.x, y: content.y + f.y, width: f.width, height: f.height } : content,
      area: d.workArea,
      scale: d.scaleFactor,
      maximized: w.isMaximized(),
      minimized: w.isMinimized(),
    };
  });
}

/** Put the window at `width`×`height`, `inset` points from the work area's
 *  top-left (so a move by input has room), and bring it to the front. Returns
 *  where it ended up — the shell's minimum may have clamped it. */
export async function place(app: ElectronApplication, width: number, height: number, inset = 24): Promise<Geometry> {
  await app.evaluate(({ BaseWindow, screen, app: a }, s) => {
    const w = BaseWindow.getAllWindows()[0];
    if (w.isMinimized()) w.restore();
    if (w.isMaximized()) w.unmaximize();
    if (w.isFullScreen()) w.setFullScreen(false);
    const area = screen.getDisplayMatching(w.getBounds()).workArea;
    w.setBounds({ x: area.x + s.inset, y: area.y + s.inset, width: s.width, height: s.height });
    w.show();
    w.moveTop();
    w.focus();
    if (process.platform === "darwin") a.focus({ steal: true });
  }, { width, height, inset });
  await new Promise((r) => setTimeout(r, 400));
  return geometry(app);
}

/** A picture of the window as the OS composites it: macOS `screencapture -l`
 *  (the window by its CGWindowID, its shadow left off), Windows the screen
 *  under its bounds (System.Drawing; the window is put on top first). */
export async function captureWindow(app: ElectronApplication, file: string): Promise<Outcome> {
  if (OS === "macos") {
    const id = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getMediaSourceId());
    const m = /^window:(\d+):/.exec(id);
    if (!m) return { ok: false, notPermitted: false, reason: `no CGWindowID in media source id "${id}"` };
    const r = await run("screencapture", ["-x", "-o", "-l", m[1], file], { timeoutMs: 20_000 });
    if (r.code !== 0 || !existsSync(file) || statSync(file).size === 0) return notPermitted(`screencapture -l ${m[1]}: exit ${r.code} ${r.err.trim()}`);
    return { ok: true, file };
  }
  if (OS === "windows") {
    const g = await geometry(app);
    await app.evaluate(({ BaseWindow }) => {
      const w = BaseWindow.getAllWindows()[0];
      w.setAlwaysOnTop(true);
      w.moveTop();
    });
    await new Promise((r) => setTimeout(r, 250));
    const px = (v: number) => Math.round(v * g.scale);
    const r = await powershell(
      `Add-Type -AssemblyName System.Drawing
${DPI}
$b = New-Object System.Drawing.Bitmap ([int]$env:W), ([int]$env:H)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen([int]$env:X, [int]$env:Y, 0, 0, $b.Size)
$b.Save($env:OUT, [System.Drawing.Imaging.ImageFormat]::Png)`,
      { X: String(px(g.bounds.x)), Y: String(px(g.bounds.y)), W: String(px(g.bounds.width)), H: String(px(g.bounds.height)), OUT: file },
    );
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setAlwaysOnTop(false));
    if (r.code !== 0 || !existsSync(file)) return notPermitted(`CopyFromScreen: exit ${r.code} ${r.err.trim().slice(0, 400)}`);
    return { ok: true, file };
  }
  return { ok: false, notPermitted: false, reason: "no window capture on Linux (page screenshots only)" };
}

// ── real mouse input ──

const DPI = `Add-Type -Namespace MafoldE2e -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][MafoldE2e.Dpi]::SetProcessDPIAware()`;

const MOUSE_WIN = `${DPI}
Add-Type -Namespace MafoldE2e -Name Mouse -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@
function Down { [MafoldE2e.Mouse]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero) }
function Up { [MafoldE2e.Mouse]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero) }
$a = $env:ARGS -split ' ' | ForEach-Object { [double]$_ }
switch ($env:CMD) {
  'move' { [void][MafoldE2e.Mouse]::SetCursorPos($a[0], $a[1]) }
  'click' { [void][MafoldE2e.Mouse]::SetCursorPos($a[0], $a[1]); Start-Sleep -Milliseconds 60; Down; Start-Sleep -Milliseconds 60; Up }
  'dclick' { [void][MafoldE2e.Mouse]::SetCursorPos($a[0], $a[1]); Start-Sleep -Milliseconds 60; Down; Up; Start-Sleep -Milliseconds 80; Down; Up }
  'drag' {
    [void][MafoldE2e.Mouse]::SetCursorPos($a[0], $a[1]); Start-Sleep -Milliseconds 80; Down; Start-Sleep -Milliseconds 120
    $n = [int]$a[5]
    for ($i = 1; $i -le $n; $i++) {
      $t = $i / $n
      [void][MafoldE2e.Mouse]::SetCursorPos([int]($a[0] + ($a[2] - $a[0]) * $t), [int]($a[1] + ($a[3] - $a[1]) * $t))
      Start-Sleep -Milliseconds ([int]($a[4] / $n))
    }
    Start-Sleep -Milliseconds 120; Up
  }
}`;

function powershell(script: string, env: Record<string, string>, timeoutMs = 60_000) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { env, timeoutMs });
}

let macTool: Promise<string | Outcome> | null = null;
/** e2e/os/macInput.swift, compiled once per run. */
function macInputTool(): Promise<string | Outcome> {
  macTool ??= (async () => {
    const dir = join(tmpdir(), "mafold-e2e-input");
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "macInput");
    const r = await run("swiftc", ["-O", join(__dirname, "macInput.swift"), "-o", bin], { timeoutMs: 240_000 });
    if (r.code !== 0 || !existsSync(bin)) return notPermitted(`swiftc: exit ${r.code} ${r.err.trim().slice(0, 400)}`);
    return bin;
  })();
  return macTool;
}

export type MouseCmd = ["move", number, number] | ["click", number, number] | ["dclick", number, number] | ["drag", number, number, number, number, number, number];

/** One real mouse gesture, in screen points (DIP on Windows: scaled here). */
export async function mouse(cmd: MouseCmd, scale = 1): Promise<Outcome> {
  const [name, ...nums] = cmd;
  if (OS === "macos") {
    const bin = await macInputTool();
    if (typeof bin !== "string") return bin;
    const ms = name === "drag" ? (nums[4] ?? 0) : 0;
    const r = await run(bin, [name, ...nums.map(String)], { timeoutMs: 20_000 + ms });
    return r.code === 0 ? { ok: true } : notPermitted(`macInput ${name}: exit ${r.code} ${r.err.trim()}`);
  }
  if (OS === "windows") {
    // Positions in physical pixels; the drag's time and step count stay as they are.
    const scaled = nums.map((v, i) => (name === "drag" && i >= 4 ? v : Math.round(v * scale)));
    const r = await powershell(MOUSE_WIN, { CMD: name, ARGS: scaled.join(" ") }, 60_000 + (name === "drag" ? (nums[4] ?? 0) : 0));
    return r.code === 0 ? { ok: true } : notPermitted(`mouse ${name}: exit ${r.code} ${r.err.trim().slice(0, 400)}`);
  }
  return notPermitted("no real input on Linux");
}

/** The title bar's own close / minimise / zoom buttons of process `pid`'s
 *  window, in screen points (macOS, through Accessibility). */
export async function windowButtons(pid: number): Promise<Record<string, Rect> | Outcome> {
  if (OS !== "macos") return notPermitted("macOS only");
  const bin = await macInputTool();
  if (typeof bin !== "string") return bin;
  const r = await run(bin, ["buttons", String(pid)]);
  const found: Record<string, Rect> = {};
  for (const line of r.out.trim().split("\n")) {
    const [name, ...n] = line.trim().split(/\s+/);
    const [x, y, width, height] = n.map(Number);
    if (n.length === 4 && [x, y, width, height].every(Number.isFinite)) found[name] = { x, y, width, height };
  }
  return Object.keys(found).length ? found : notPermitted(`macInput buttons: ${r.out.trim() || r.err.trim() || `exit ${r.code}`}`);
}

/** What macOS says this process may do (informational; the page decides). */
export async function inputAccess(): Promise<string> {
  if (OS !== "macos") return "n/a";
  const bin = await macInputTool();
  if (typeof bin !== "string") return bin.ok ? "" : bin.reason;
  return (await run(bin, ["access"])).out.trim();
}

/** macOS's choice for a double-click on a title bar: Maximize (zoom, the
 *  default), Minimize, or None. */
export async function doubleClickAction(): Promise<string> {
  if (OS !== "macos") return "n/a";
  const r = await run("defaults", ["read", "-g", "AppleActionOnDoubleClick"]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : "Maximize (default)";
}

// ── screen recording ──

export interface Recording {
  /** Resolves once the recorder has finished and the file is written. */
  done: Promise<Outcome>;
  tool: string;
}

const which = async (cmd: string) => (await run(OS === "windows" ? "where" : "which", [cmd], { timeoutMs: 10_000 })).code === 0;

/** Record the screen for `secs` seconds into `file` (without extension: .mov
 *  on macOS, .mp4 with ffmpeg). macOS `screencapture -v -V`, else ffmpeg
 *  (avfoundation / gdigrab). Null when there is no recorder at all. */
export async function record(fileBase: string, secs: number, rect?: Rect): Promise<Recording | null> {
  if (OS === "macos") {
    const file = `${fileBase}.mov`;
    const args = ["-x", "-k", "-v", "-V", String(secs)];
    if (rect) args.push("-R", [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v)).join(","));
    return { tool: "screencapture -v", done: spawnUntil("screencapture", [...args, file], file, secs) };
  }
  if (await which("ffmpeg")) {
    const file = `${fileBase}.mp4`;
    const input = OS === "windows" ? ["-f", "gdigrab", "-framerate", "15", "-i", "desktop"] : ["-f", "x11grab", "-framerate", "15", "-i", process.env.DISPLAY ?? ":99"];
    return {
      tool: `ffmpeg ${input[1]}`,
      done: spawnUntil("ffmpeg", ["-y", "-loglevel", "error", ...input, "-t", String(secs), "-pix_fmt", "yuv420p", file], file, secs),
    };
  }
  return null;
}

function spawnUntil(cmd: string, args: string[], file: string, secs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    p.stderr.on("data", (d) => (err += String(d)));
    // A recorder the system refuses may sit waiting: stop it well after it should be done.
    const kill = setTimeout(() => p.kill("SIGKILL"), (secs + 30) * 1000);
    p.on("error", (e) => {
      clearTimeout(kill);
      resolve(notPermitted(`${cmd}: ${e.message}`));
    });
    p.on("exit", (code) => {
      clearTimeout(kill);
      const size = existsSync(file) ? statSync(file).size : 0;
      resolve(size > 0 ? { ok: true, file, note: `exit ${code}` } : notPermitted(`${cmd}: exit ${code}, no file ${err.trim().slice(0, 400)}`));
    });
  });
}

/** PNG width × height, from the header. */
export function pngSize(file: string): { width: number; height: number } | null {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}
