// The desktop's actions on this computer's bots, driven against a stand-in
// mafold-cli (activity center D3): restarting one of the person's bots,
// signing a refused Mafold login in again, and signing Claude Code in. Each
// counts only once this computer's own `status --json` reads it back; a cli
// that says "done" while the status stays as it was is `unverified`.
//
// The cli is stood in for at the module the manager runs it through
// (`daemon/cli.ts`): `runCli` answers from a status this test sets, and
// `spawnCli` hands back a child whose output the test writes.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonStatus } from "../src/shared/desktopHost.generated";
// `vi.mock` below is hoisted above this import: the manager gets the stand-in.
import { DaemonManager } from "../src/main/daemon/manager";
import type { CliStatus } from "../src/main/daemon/model";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  /** What the shell wrote to stdin, and whether it closed it. */
  wrote = "";
  closed = false;
  killed = false;
  constructor() {
    super();
    this.stdin.on("data", (c: Buffer) => (this.wrote += c.toString("utf8")));
    this.stdin.on("finish", () => (this.closed = true));
  }
  say(ev: object): void {
    this.stdout.write(`${JSON.stringify(ev)}\n`);
  }
  exit(code: number | null): void {
    this.emit("exit", code);
  }
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
}

const cli = vi.hoisted(() => ({
  status: null as object | null,
  spawned: [] as { args: string[]; child: FakeChild }[],
  ran: [] as string[][],
  restart: null as object | null,
  /** The status once the supervisor has done the restart. */
  afterRestart: null as object | null,
}));

vi.mock("../src/main/daemon/cli", () => ({
  canonicalExe: (p: { exe: string }) => p.exe,
  ensureInstalled: async () => {},
  runCli: async (_p: unknown, _env: unknown, args: string[]) => {
    cli.ran.push(args);
    if (args[0] === "status") return { code: 0, stdout: `${JSON.stringify(cli.status)}\n`, stderr: "" };
    if (args[0] === "restart") {
      if (cli.afterRestart) cli.status = cli.afterRestart;
      return { code: 0, stdout: `${JSON.stringify(cli.restart)}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  },
  spawnCli: (_p: unknown, _env: unknown, args: string[]) => {
    const child = new FakeChild();
    cli.spawned.push({ args, child });
    return child;
  },
}));

let dir = "";
let exe = "";
let opened: string[] = [];
let emitted: DaemonStatus[] = [];

const status = (extra: Partial<CliStatus> = {}): CliStatus => ({
  version: "0.9.151",
  supervisor: { running: true, registered_exe_canonical: exe },
  accounts: ["alice"],
  daemons: [{ name: "alice:cc", running: true, pid: 4100 }],
  harnesses: [{ id: "claude-code", available: true, version: "2.1.312" }],
  issues: [],
  ...extra,
});

const manager = (canOpen = true) =>
  new DaemonManager({
    paths: { home: dir, exe, bundled: null },
    env: async () => ({}),
    confirm: async () => true,
    emit: (s) => emitted.push(s),
    openExternal: (url) => {
      opened.push(url);
      return canOpen;
    },
    emitLogs: () => {},
    saveAs: async () => null,
  });

/** Let the stand-in's output reach the manager. */
const tick = () => new Promise((res) => setImmediate(res));
const last = () => cli.spawned[cli.spawned.length - 1].child;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mafold-desktop-d3-"));
  exe = join(dir, "mafold");
  writeFileSync(exe, "");
  cli.status = status();
  cli.spawned = [];
  cli.ran = [];
  cli.restart = null;
  cli.afterRestart = null;
  opened = [];
  emitted = [];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("restarting a bot is the person's own", () => {
  it("turns away someone else's bot without asking the cli", async () => {
    cli.status = status({ accounts: ["alice", "bob"], daemons: [{ name: "bob:cc", running: true, pid: 5100 }] });
    expect(await manager().restart("bob:cc", "alice")).toEqual({ ok: false, error: "not_yours" });
    expect(cli.ran.some((a) => a[0] === "restart")).toBe(false);
  });
  it("restarts their own (names compare case-insensitively), read back as the new process", async () => {
    cli.restart = { ok: true, code: "restarted", old_pid: 4100, new_pid: 4200, interrupted: 0 };
    cli.afterRestart = status({ daemons: [{ name: "alice:cc", running: true, pid: 4200 }] });
    expect(await manager().restart("alice:cc", "Alice")).toEqual({ ok: true, oldPid: 4100, newPid: 4200, interrupted: 0 });
  });
  it("a page that doesn't say who it is gets what it always got", async () => {
    cli.restart = { ok: true, code: "restarted", old_pid: 4100, new_pid: 4200, interrupted: 0 };
    // The status still shows the old process: the cli's word alone is not a restart.
    expect(await manager().restart("alice:cc")).toMatchObject({ ok: false, error: "unverified" });
  });
});

describe("signing Mafold in again", () => {
  const refused = (who = "alice") => status({ issues: [{ code: "mafold_signed_out", scope: "account", subject: who, accounts: [who] }] });

  it("hands over a device code, and counts once the status no longer says refused", async () => {
    cli.status = refused();
    const m = manager();
    const p = m.relogin("alice");
    await tick();
    expect(last()).toBeDefined();
    expect(cli.spawned[0].args).toEqual(["login", "--device-json", "--no-up"]);
    last().say({ event: "code", user_code: "WXYZ-1234", verify_url: "https://mafold.com/login/device", expires_in: 600 });
    expect(await p).toEqual({ userCode: "WXYZ-1234" });
    cli.status = status();
    last().say({ event: "approved", username: "alice" });
    last().exit(0);
    await vi.waitFor(() => expect(emitted[emitted.length - 1].task).toBeNull());
    // No `up`: the supervisor serving the others takes the new login itself.
    expect(cli.ran.some((a) => a[0] === "up")).toBe(false);
  });

  it("is unverified when the cli says approved but the status still says refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    cli.status = refused();
    const m = manager();
    const p = m.relogin("alice");
    await vi.advanceTimersByTimeAsync(0);
    last().say({ event: "code", user_code: "WXYZ-1234" });
    await p;
    last().say({ event: "approved", username: "alice" });
    last().exit(0);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(emitted[emitted.length - 1].task).toMatchObject({ step: "relogin", error: "unverified" });
  });

  it("is unverified when someone else approved it", async () => {
    cli.status = refused();
    const m = manager();
    const p = m.relogin("alice");
    await tick();
    last().say({ event: "code", user_code: "WXYZ-1234" });
    await p;
    last().say({ event: "approved", username: "bob" });
    last().exit(0);
    await vi.waitFor(() => expect(emitted[emitted.length - 1].task).toMatchObject({ step: "relogin", error: "unverified" }));
  });

  it("someone not signed in here is a first sign-in (`enable`), not this", async () => {
    expect(await manager().relogin("carol")).toMatchObject({ error: "failed" });
    expect(cli.spawned).toEqual([]);
  });

  it("a code nobody approved: said as failed when it expires", async () => {
    cli.status = refused();
    const m = manager();
    const p = m.relogin("alice");
    await tick();
    last().say({ event: "code", user_code: "WXYZ-1234" });
    await p;
    last().say({ event: "expired" });
    last().exit(1);
    await vi.waitFor(() => expect(emitted[emitted.length - 1].task).toMatchObject({ step: "relogin", error: "failed" }));
    // Free again for the next try.
    const again = m.relogin("alice");
    await tick();
    expect(cli.spawned).toHaveLength(2);
    last().say({ event: "code", user_code: "ABCD-5678" });
    expect(await again).toEqual({ userCode: "ABCD-5678" });
  });
});

describe("signing Claude Code in", () => {
  const signedOut = () =>
    status({
      harnesses: [{ id: "claude-code", available: true, version: "2.1.312", health: { state: "unauthenticated" } }],
      issues: [{ code: "runtime_signed_out", scope: "runtime", subject: "claude-code", bots: ["alice:cc"] }],
    });
  const URL = "https://claude.ai/oauth/authorize?code=true&client_id=x&state=y";

  /** Started, with the link out. */
  async function linked(m: InstanceType<typeof DaemonManager>) {
    const p = m.runtimeLogin("claude-code");
    await tick();
    last().say({ event: "started", account: "default", adding: false });
    last().say({ event: "link", url: URL });
    return p;
  }

  it("opens the sign-in page, feeds the code back, and counts once the status reads it signed in", async () => {
    cli.status = signedOut();
    const m = manager();
    expect(await linked(m)).toEqual({ url: URL, opened: true });
    expect(cli.spawned[0].args).toEqual(["runtime", "login", "claude-code", "--json"]);
    expect(opened).toEqual([URL]);
    const done = m.runtimeLoginCode("  abc#123  ");
    await tick();
    expect(last().wrote).toBe("abc#123\n");
    cli.status = status({ harnesses: [{ id: "claude-code", available: true, health: { state: "ok" } }] });
    last().say({ event: "done", account: "default", added: false, now: { state: "known", email: "a@example.com" } });
    last().exit(0);
    expect(await done).toEqual({ ok: true, email: "a@example.com" });
  });

  it("is unverified when the cli says done but the status still says signed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    cli.status = signedOut();
    const m = manager();
    const p = m.runtimeLogin("claude-code");
    await vi.advanceTimersByTimeAsync(0);
    last().say({ event: "link", url: URL });
    await p;
    const done = m.runtimeLoginCode("abc#123");
    last().say({ event: "done", now: { state: "known", email: "a@example.com" } });
    last().exit(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await done).toMatchObject({ ok: false, error: "unverified" });
  });

  it("passes on the runtime's refusal of the code", async () => {
    cli.status = signedOut();
    const m = manager();
    await linked(m);
    const done = m.runtimeLoginCode("wrong");
    last().say({ event: "failed", code: "rejected", detail: "claude auth login exited 1" });
    last().exit(1);
    expect(await done).toEqual({ ok: false, error: "rejected", detail: "claude auth login exited 1" });
  });

  it("shows a link off Anthropic's hosts but never opens it", async () => {
    cli.status = signedOut();
    const m = manager();
    const p = m.runtimeLogin("claude-code");
    await tick();
    last().say({ event: "link", url: "https://example.com/phish" });
    expect(await p).toEqual({ url: "https://example.com/phish", opened: false });
    expect(opened).toEqual([]);
  });

  it("cancelling closes the cli's stdin — its own way to stop `claude`", async () => {
    cli.status = signedOut();
    const m = manager();
    await linked(m);
    const child = last();
    await m.runtimeLoginCancel();
    await tick();
    expect(child.closed).toBe(true);
    expect(child.wrote).toBe("");
    expect(await m.runtimeLoginCode("abc")).toEqual({ ok: false, error: "not_started" });
  });

  it("a second start replaces the one waiting", async () => {
    cli.status = signedOut();
    const m = manager();
    await linked(m);
    const first = last();
    await linked(m);
    expect(first.closed).toBe(true);
    expect(cli.spawned).toHaveLength(2);
  });

  it("says why it can't start: unsupported, not installed, a mafold without `runtime login`", async () => {
    const m = manager();
    expect(await m.runtimeLogin("codex")).toEqual({ error: "unsupported" });
    cli.status = status({ harnesses: [{ id: "claude-code", available: false }] });
    expect(await m.runtimeLogin("claude-code")).toEqual({ error: "runtime_missing" });
    cli.status = signedOut();
    const p = m.runtimeLogin("claude-code");
    await tick();
    last().stderr.write("error: unrecognized subcommand 'runtime'\n");
    await tick();
    last().exit(2);
    expect(await p).toEqual({ error: "outdated" });
  });

  it("a code with no sign-in waiting, or not a code, is turned away", async () => {
    const m = manager();
    expect(await m.runtimeLoginCode("abc")).toEqual({ ok: false, error: "not_started" });
    cli.status = signedOut();
    await linked(m);
    expect(await m.runtimeLoginCode("a\nb")).toEqual({ ok: false, error: "refused" });
    expect(await m.runtimeLoginCode(42)).toEqual({ ok: false, error: "refused" });
    expect(last().wrote).toBe("");
  });
});
