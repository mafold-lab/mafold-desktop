// This computer's logs as the desktop hands them to the page, driven against a
// stand-in mafold-cli (activity center D4): reading the end of a log, following
// it — at most four frames a second, each at most 64 KB, oldest lines dropped
// first, stopped when asked — and writing a diagnostics file where the save
// dialog says, counted only once it is there as big as the cli said.
//
// The cli is stood in for at the module the manager runs it through
// (`daemon/cli.ts`), as in daemonActions.spec.ts.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogFrame } from "../src/shared/desktopHost.generated";
// `vi.mock` below is hoisted above this import: the manager gets the stand-in.
import { DaemonManager } from "../src/main/daemon/manager";
import { clipLine, diagnoseName, lineCount, LogBuffer, MAX_FRAME_BYTES, MAX_LINE_CHARS, MAX_RAW_LINE, MAX_TAIL_BYTES, readLogLine } from "../src/main/daemon/logs";
import type { CliStatus } from "../src/main/daemon/model";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  line(text: string): void {
    this.stdout.write(`${JSON.stringify({ type: "line", text })}\n`);
  }
  say(ev: object): void {
    this.stdout.write(`${JSON.stringify(ev)}\n`);
  }
  close(code: number | null, stderr = ""): void {
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.emit("close", code));
  }
  kill(): boolean {
    this.killed = true;
    this.close(null);
    return true;
  }
}

const cli = vi.hoisted(() => ({
  status: null as object | null,
  spawned: [] as { args: string[]; child: FakeChild }[],
  ran: [] as string[][],
  /** How `logs` / `diagnose` answer: what they print and how they exit. */
  logs: { code: 0, stdout: "", stderr: "" },
  diagnose: null as null | ((out: string) => { code: number; stdout: string; stderr: string }),
}));

vi.mock("../src/main/daemon/cli", () => ({
  canonicalExe: (p: { exe: string }) => p.exe,
  ensureInstalled: async () => {},
  runCli: async (_p: unknown, _env: unknown, args: string[]) => {
    cli.ran.push(args);
    if (args[0] === "status") return { code: 0, stdout: `${JSON.stringify(cli.status)}\n`, stderr: "" };
    if (args[0] === "diagnose" && cli.diagnose) return cli.diagnose(args[args.indexOf("--out") + 1]);
    return { code: 0, stdout: "", stderr: "" };
  },
  spawnCli: (_p: unknown, _env: unknown, args: string[]) => {
    const child = new FakeChild();
    cli.spawned.push({ args, child });
    // A one-off `logs` answers at once with what the test set.
    if (args[0] === "logs" && !args.includes("-f")) {
      setImmediate(() => {
        child.stdout.write(cli.logs.stdout);
        child.close(cli.logs.code, cli.logs.stderr);
      });
    }
    return child;
  },
}));

let dir = "";
let exe = "";
let frames: ({ id: number } & LogFrame)[] = [];
let saveTo: string | null = null;
let asked: string[] = [];

const status = (extra: Partial<CliStatus> = {}): CliStatus => ({
  version: "0.9.151",
  supervisor: { running: true, registered_exe_canonical: exe },
  accounts: ["alice"],
  daemons: [
    { name: "alice:cc", running: true, pid: 4100 },
    { name: "bob:cc", running: true, pid: 5100 },
  ],
  harnesses: [],
  issues: [],
  ...extra,
});

const manager = () =>
  new DaemonManager({
    paths: { home: dir, exe, bundled: null },
    env: async () => ({}),
    confirm: async () => true,
    emit: () => {},
    openExternal: () => true,
    emitLogs: (f) => frames.push(f),
    saveAs: async (name) => {
      asked.push(name);
      return saveTo;
    },
  });

const printed = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
const tick = () => new Promise((res) => setImmediate(res));
const last = () => cli.spawned[cli.spawned.length - 1].child;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mafold-desktop-d4-"));
  exe = join(dir, "mafold");
  writeFileSync(exe, "");
  cli.status = status();
  cli.spawned = [];
  cli.ran = [];
  cli.logs = { code: 0, stdout: "", stderr: "" };
  cli.diagnose = null;
  frames = [];
  saveTo = null;
  asked = [];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("the limits (logs.ts)", () => {
  it("a frame never holds more than 64 KB: the oldest lines go first, and are counted", () => {
    const buf = new LogBuffer();
    const line = "x".repeat(1000);
    for (let i = 0; i < 200; i++) buf.push(`${i} ${line}`);
    const f = buf.take()!;
    expect(JSON.stringify(f.lines).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(f.lines!.length + f.skipped!).toBe(200);
    // What's kept is the newest, in order.
    expect(f.lines![f.lines!.length - 1].startsWith("199 ")).toBe(true);
    expect(f.lines![0].startsWith(`${f.skipped} `)).toBe(true);
    expect(buf.take()).toBeNull();
  });
  it("counts the cost as encoded: a line of quotes takes twice its length", () => {
    const buf = new LogBuffer(100);
    buf.push('"'.repeat(30)); // 62 encoded + 1
    buf.push('"'.repeat(30));
    expect(buf.take()).toEqual({ lines: ['"'.repeat(30)], skipped: 1 });
  });
  it("cuts a line past 4000 characters, and a cut line still fits a frame", () => {
    expect(clipLine("a".repeat(MAX_LINE_CHARS))).toHaveLength(MAX_LINE_CHARS);
    expect(clipLine("a".repeat(MAX_LINE_CHARS + 5))).toBe(`${"a".repeat(MAX_LINE_CHARS)}…`);
    const buf = new LogBuffer();
    buf.push("\u0001".repeat(100_000)); // every character escaped: 6× in JSON
    const f = buf.take()!;
    expect(f.lines).toHaveLength(1);
    expect(JSON.stringify(f.lines).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
  it("says the log rotated, and nothing at all when nothing happened", () => {
    const buf = new LogBuffer();
    buf.rotate();
    expect(buf.take()).toEqual({ rotated: true });
    expect(buf.take()).toBeNull();
  });
  it("asks for 1–500 lines whatever the page sent", () => {
    expect(lineCount(100)).toBe(100);
    expect(lineCount(10_000)).toBe(500);
    expect(lineCount(0)).toBe(1);
    expect(lineCount(2.7)).toBe(2);
    expect(lineCount("50")).toBe(40);
    expect(lineCount(Number.NaN)).toBe(40);
  });
  it("reads the cli's lines, and nothing else", () => {
    expect(readLogLine('{"type":"line","text":"  indented"}')).toEqual({ type: "line", text: "  indented" });
    expect(readLogLine('{"type":"rotated"}')).toEqual({ type: "rotated" });
    expect(readLogLine('{"type":"open","source":"bot","name":"alice:cc","path":"/h/.mafold/daemons/alice_cc/log"}')).toEqual({
      type: "open",
      path: "/h/.mafold/daemons/alice_cc/log",
    });
    expect(readLogLine("plain text")).toBeNull();
    expect(readLogLine('{"type":"line"}')).toBeNull();
    expect(readLogLine("{broken")).toBeNull();
  });
  it("names the file as the cli would, in UTC", () => {
    expect(diagnoseName(Date.UTC(2026, 9, 29, 9, 15, 2))).toBe("mafold-diagnose-20261029-091502.json");
  });
});

describe("reading a log", () => {
  it("reads the end of their own bot's log through the cli", async () => {
    cli.logs = { code: 0, stdout: printed({ type: "open", source: "bot", name: "alice:cc", path: "/x" }, { type: "line", text: "one" }, { type: "line", text: "two" }), stderr: "" };
    expect(await manager().logs("Alice", "alice:cc", 100)).toEqual({ ok: true, lines: ["one", "two"] });
    expect(cli.spawned.map((s) => s.args)).toEqual([["logs", "alice:cc", "-n", "100", "--json"]]);
  });
  it("turns away someone else's bot before the cli is asked anything", async () => {
    expect(await manager().logs("alice", "bob:cc", 40)).toEqual({ ok: false, error: "not_yours" });
    expect(cli.ran).toEqual([]);
    expect(cli.spawned).toEqual([]);
  });
  it("a bot that doesn't run here is unknown", async () => {
    expect(await manager().logs("alice", "alice:gone", 40)).toEqual({ ok: false, error: "unknown_bot" });
    expect(cli.spawned).toEqual([]);
  });
  it("the supervisor's: only for someone signed in on this computer", async () => {
    cli.logs = { code: 0, stdout: printed({ type: "open", source: "supervisor", name: null, path: "/x" }, { type: "line", text: "up" }), stderr: "" };
    expect(await manager().logs("carol", null, 40)).toEqual({ ok: false, error: "not_yours" });
    expect(await manager().logs("alice", null, 40)).toEqual({ ok: true, lines: ["up"] });
    expect(cli.spawned.map((s) => s.args)).toEqual([["logs", "-n", "40", "--json"]]);
  });
  it("500 long lines — megabytes, as the cli prints them — come back as the newest that fit in 256 KB", async () => {
    const long = "y".repeat(9000);
    cli.logs = {
      code: 0,
      stdout: printed({ type: "open", source: "bot", name: "alice:cc", path: "/x" }, ...Array.from({ length: 500 }, (_, i) => ({ type: "line", text: `${i} ${long}` }))),
      stderr: "",
    };
    expect(cli.logs.stdout.length).toBeGreaterThan(4 * 1024 * 1024);
    const r = await manager().logs("alice", "alice:cc", 500);
    if (!r.ok) throw new Error(`not read: ${r.error}`);
    expect(JSON.stringify(r.lines).length).toBeLessThanOrEqual(MAX_TAIL_BYTES);
    expect(r.lines.length + (r.skipped ?? 0)).toBe(500);
    expect(r.lines[r.lines.length - 1]).toBe(`499 ${"y".repeat(MAX_LINE_CHARS - 4)}…`);
  });
  it("says what went wrong, as a code", async () => {
    cli.logs = { code: 1, stdout: "", stderr: "Error: no log for `alice:cc` (looked at /x)\n" };
    expect(await manager().logs("alice", "alice:cc", 40)).toMatchObject({ ok: false, error: "no_log" });
    cli.logs = { code: 2, stdout: "", stderr: "error: unrecognized subcommand 'logs'\n" };
    expect(await manager().logs("alice", "alice:cc", 40)).toMatchObject({ ok: false, error: "outdated" });
    // Printed nothing the shell can read: not a log.
    cli.logs = { code: 0, stdout: "one\ntwo\n", stderr: "" };
    expect(await manager().logs("alice", "alice:cc", 40)).toMatchObject({ ok: false, error: "outdated" });
    cli.status = null;
    rmSync(exe);
    expect(await manager().logs("alice", "alice:cc", 40)).toEqual({ ok: false, error: "cli_missing" });
  });
});

describe("following a log", () => {
  it("sends what gets written in frames, at most four a second", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const m = manager();
    expect(await m.followLogs(1, "alice", "alice:cc", 50)).toEqual({ ok: true });
    expect(cli.spawned[0].args).toEqual(["logs", "alice:cc", "-n", "50", "-f", "--json"]);
    last().say({ type: "open", source: "bot", name: "alice:cc", path: "/x" });
    for (let i = 0; i < 30; i++) last().line(`line ${i}`);
    await tick();
    expect(frames).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ id: 1, lines: Array.from({ length: 30 }, (_, i) => `line ${i}`) });
    // Nothing new: no frame.
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(1);
    last().say({ type: "rotated" });
    last().line("fresh");
    await tick();
    vi.advanceTimersByTime(250);
    expect(frames[1]).toEqual({ id: 1, lines: ["fresh"], rotated: true });
    m.stopFollow(null, "closed");
  });

  it("a flood reaches the page as one 64 KB frame per tick, the rest counted as skipped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const m = manager();
    await m.followLogs(1, "alice", null, 500);
    const big = "z".repeat(3000);
    for (let i = 0; i < 400; i++) last().line(`${i} ${big}`);
    await tick();
    vi.advanceTimersByTime(250);
    expect(frames).toHaveLength(1);
    const f = frames[0];
    expect(JSON.stringify(f).length).toBeLessThan(MAX_FRAME_BYTES + 200);
    expect(f.lines!.length + f.skipped!).toBe(400);
    expect(f.lines![f.lines!.length - 1].startsWith("399 ")).toBe(true);
    m.stopFollow(null, "closed");
  });

  it("stops when the window closes: the cli is ended, the page hears why, nothing comes after", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const m = manager();
    await m.followLogs(7, "alice", "alice:cc", 40);
    const child = last();
    child.line("before");
    await tick();
    m.stopFollow(null, "closed");
    expect(child.killed).toBe(true);
    // What was waiting goes out first, then the end.
    expect(frames).toEqual([{ id: 7, lines: ["before"] }, { id: 7, end: "closed" }]);
    child.line("after");
    await tick();
    vi.advanceTimersByTime(1000);
    expect(frames).toHaveLength(2);
  });

  it("stops the one the page names, and not another", async () => {
    const m = manager();
    await m.followLogs(3, "alice", "alice:cc", 40);
    m.stopFollow(2, "closed");
    expect(last().killed).toBe(false);
    m.stopFollow(3, "closed");
    expect(last().killed).toBe(true);
    expect(frames).toEqual([{ id: 3, end: "closed" }]);
  });

  it("one at a time: a newer follow ends the older", async () => {
    const m = manager();
    await m.followLogs(1, "alice", "alice:cc", 40);
    const first = last();
    await m.followLogs(2, "alice", null, 40);
    expect(first.killed).toBe(true);
    expect(frames).toEqual([{ id: 1, end: "replaced" }]);
    expect(cli.spawned).toHaveLength(2);
    m.stopFollow(null, "closed");
  });

  it("stopped before its cli ran, it never runs", async () => {
    const m = manager();
    const p = m.followLogs(4, "alice", "alice:cc", 40);
    m.stopFollow(null, "closed");
    expect(await p).toEqual({ ok: false, error: "closed" });
    expect(cli.spawned).toEqual([]);
  });

  it("turns away someone else's bot without running anything", async () => {
    expect(await manager().followLogs(1, "alice", "bob:cc", 40)).toEqual({ ok: false, error: "not_yours" });
    expect(cli.ran).toEqual([]);
    expect(cli.spawned).toEqual([]);
  });

  it("a log that isn't there, or a mafold without `logs`: said in the last frame", async () => {
    const m = manager();
    await m.followLogs(1, "alice", "alice:cc", 40);
    last().close(1, "Error: no log for `alice:cc` (looked at /x)\n");
    await vi.waitFor(() => expect(frames).toEqual([{ id: 1, end: "no_log" }]));
    await m.followLogs(2, "alice", "alice:cc", 40);
    last().close(2, "error: unexpected argument '--json' found\n");
    await vi.waitFor(() => expect(frames[1]).toEqual({ id: 2, end: "outdated" }));
  });

  it("a character split across two reads arrives whole", async () => {
    const m = manager();
    await m.followLogs(1, "alice", "alice:cc", 40);
    const bytes = Buffer.from(`${JSON.stringify({ type: "line", text: "日志里的中文" })}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 1; // inside 中's three bytes
    last().stdout.write(bytes.subarray(0, cut));
    await tick();
    last().stdout.write(bytes.subarray(cut));
    last().close(0);
    await vi.waitFor(() => expect(frames[0]).toEqual({ id: 1, lines: ["日志里的中文"] }));
  });

  it("a line too long to hold is dropped and counted, and the next one comes through", async () => {
    const m = manager();
    await m.followLogs(1, "alice", "alice:cc", 40);
    const huge = JSON.stringify({ type: "line", text: "h".repeat(3 * MAX_RAW_LINE) });
    for (let i = 0; i < huge.length; i += 64 * 1024) {
      last().stdout.write(huge.slice(i, i + 64 * 1024));
      await tick();
    }
    last().stdout.write("\n");
    last().line("after");
    last().close(0);
    await vi.waitFor(() => expect(frames[0]).toEqual({ id: 1, lines: ["after"], skipped: 1 }));
  });

  it("lines printed just before the cli ends still go out", async () => {
    const m = manager();
    await m.followLogs(1, "alice", "alice:cc", 40);
    last().line("last words");
    last().close(0);
    await vi.waitFor(() => expect(frames).toEqual([{ id: 1, lines: ["last words"] }, { id: 1, end: "done" }]));
  });

  it("quitting the app ends it", async () => {
    const m = manager();
    await m.followLogs(1, "alice", "alice:cc", 40);
    m.dispose();
    expect(last().killed).toBe(true);
    expect(frames).toEqual([{ id: 1, end: "closed" }]);
  });
});

describe("the diagnostics file", () => {
  const writes = (bytes: number, wrote = bytes) => (out: string) => {
    writeFileSync(out, "d".repeat(wrote));
    return { code: 0, stdout: `${JSON.stringify({ path: out, bytes, masked: 3 })}\n`, stderr: "" };
  };

  it("goes where the save dialog says, and counts once it is there as big as said", async () => {
    saveTo = join(dir, "picked.json");
    cli.diagnose = writes(1234);
    expect(await manager().diagnose()).toEqual({ ok: true, name: "picked.json", bytes: 1234, masked: 3 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^mafold-diagnose-\d{8}-\d{6}\.json$/);
    expect(cli.ran.find((a) => a[0] === "diagnose")).toEqual(["diagnose", "--out", saveTo, "--json"]);
  });

  it("the person closed the dialog: nothing is written", async () => {
    cli.diagnose = writes(10);
    expect(await manager().diagnose()).toEqual({ ok: false, error: "cancelled" });
    expect(cli.ran.some((a) => a[0] === "diagnose")).toBe(false);
  });

  it("the cli says it wrote it, but the file isn't as said: unverified", async () => {
    saveTo = join(dir, "short.json");
    cli.diagnose = writes(1234, 10);
    expect(await manager().diagnose()).toEqual({ ok: false, error: "unverified" });
    saveTo = join(dir, "never.json");
    cli.diagnose = (out) => ({ code: 0, stdout: `${JSON.stringify({ path: out, bytes: 5, masked: 0 })}\n`, stderr: "" });
    expect(await manager().diagnose()).toEqual({ ok: false, error: "unverified" });
  });

  it("a mafold without `diagnose` is outdated", async () => {
    saveTo = join(dir, "x.json");
    cli.diagnose = () => ({ code: 2, stdout: "", stderr: "error: unrecognized subcommand 'diagnose'\n" });
    expect(await manager().diagnose()).toMatchObject({ ok: false, error: "outdated" });
  });

  it("asked twice at once: one dialog, one outcome", async () => {
    saveTo = join(dir, "once.json");
    cli.diagnose = writes(42);
    const m = manager();
    const [a, b] = await Promise.all([m.diagnose(), m.diagnose()]);
    expect(a).toEqual(b);
    expect(asked).toHaveLength(1);
  });

  it("no mafold here: no dialog", async () => {
    rmSync(exe);
    expect(await manager().diagnose()).toEqual({ ok: false, error: "cli_missing" });
    expect(asked).toEqual([]);
  });
});
