// Handing a computer whose bots another mafold runs to the shell (activity
// center D6), driven from the desktop against a stand-in cli: mafold-cli C10's
// `up --adopt --check --json` says what it would do, the person agrees in a
// native dialog naming the bots it restarts, and `up --adopt --json` moves
// them. It counts only once this computer's own `status --json` reads back as
// the shell's — never on what the cli printed.
//
// The cli is stood in for at the module the manager runs it through
// (`daemon/cli.ts`), as in daemonUpdate.spec.ts: `status` answers from a status
// this test holds, and every other command from `cli.answers`, which may change
// that status first.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonStatus } from "../src/shared/desktopHost.generated";
import { Strings, type StringTable } from "../src/main/i18n";
import { adoptReadsBack, readAdoptCheck, sameAdopt } from "../src/main/daemon/model";
// `vi.mock` below is hoisted above this import: the manager gets the stand-in.
import { confirmText, DaemonManager, type Confirm } from "../src/main/daemon/manager";

type Ran = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Status = Record<string, any>;

const cli = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  ran: [] as string[][],
  timeouts: {} as Record<string, number>,
  answers: {} as Record<string, () => Ran | Promise<Ran>>,
}));

vi.mock("../src/main/daemon/cli", () => ({
  canonicalExe: (p: { exe: string }) => p.exe,
  ensureInstalled: async () => {},
  runCli: async (_p: unknown, _env: unknown, args: string[], timeoutMs: number) => {
    cli.ran.push(args);
    cli.timeouts[args.join(" ")] = timeoutMs;
    if (args[0] === "status") return { code: 0, stdout: `${JSON.stringify(cli.status)}\n`, stderr: "" };
    const answer = cli.answers[args.join(" ")];
    // What a mafold from before the command says: clap's usage error.
    return answer ? answer() : { code: 2, stdout: "", stderr: `error: unexpected argument '${args[1] ?? args[0]}' found\n` };
  },
  spawnCli: () => {
    throw new Error("nothing here spawns");
  },
}));

let dir = "";
let exe = "";
let asked: Confirm[] = [];
let answer: () => boolean | Promise<boolean> = () => true;

const OTHER = "/home/alice/dev/mafold/target/release/mafold";
const st = (): Status => cli.status as Status;
/** Alice's two bots, run by a dev build's service set up with `--no-auto-update`. */
const foreign = (): Status => ({
  version: "0.9.151",
  supervisor: {
    running: true,
    pid: 900,
    autostart: true,
    registered_exe: OTHER,
    registered_exe_canonical: OTHER,
    no_auto_update: true,
    not_ours: ["elsewhere", "update_flag"],
    version: "0.9.151",
  },
  accounts: ["alice"],
  daemons: [
    { name: "alice:cc", running: true, busy: false, pid: 4100 },
    { name: "alice:cx", running: true, busy: true, pid: 4200 },
  ],
  harnesses: [{ id: "claude-code", available: true }],
  issues: [],
  update: { channel: "stable", auto_update: false, auto_update_setting: true, checked_at: 1, available: null, failed: null, skipped: null },
});

/** `up --adopt [--check] --json` as mafold-cli prints it: one object, after any lines for people. */
const adoptJson = (o: object, code = 0): Ran => ({
  code,
  stdout: `${JSON.stringify({
    ok: true,
    exe,
    reasons: st().supervisor.not_ours ?? [],
    registered_exe: st().supervisor.registered_exe ?? null,
    service_base: "https://api.mafold.ai",
    was_running: st().supervisor.running ? st().supervisor.pid : null,
    pid: null,
    bots: (st().daemons as Status[]).map((d) => ({ name: d.name, pid: d.running ? d.pid : null, busy: !!d.busy })),
    cut: [],
    auto_update: st().update.auto_update_setting,
    ...o,
  })}\n`,
  stderr: "",
});
const CHECK = "up --adopt --check --json";
const ADOPT = "up --adopt --json";
const adoptable = () => (cli.answers[CHECK] = () => adoptJson({ code: "adoptable" }));
/** What the real move leaves behind: the service runs this binary without the
 *  flag, a new supervisor, every bot a new process, the setting in effect. */
const moved = () => {
  const s = st();
  s.supervisor = { running: true, pid: 901, autostart: true, registered_exe: exe, registered_exe_canonical: exe, no_auto_update: false, not_ours: [], version: s.version };
  for (const d of s.daemons as Status[]) {
    d.pid += 1000;
    d.running = true;
    d.busy = false;
  }
  s.update.auto_update = s.update.auto_update_setting;
};

const manager = () =>
  new DaemonManager({
    paths: { home: dir, exe, bundled: null },
    env: async () => ({}),
    confirm: async (a) => {
      asked.push(a);
      return answer();
    },
    emit: () => {},
    openExternal: () => false,
    emitLogs: () => {},
    saveAs: async () => null,
  });

const commands = () => cli.ran.filter((a) => a[0] !== "status").map((a) => a.join(" "));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mafold-desktop-d6-"));
  exe = join(dir, "mafold");
  writeFileSync(exe, "");
  cli.status = foreign();
  cli.ran = [];
  cli.timeouts = {};
  cli.answers = {};
  asked = [];
  answer = () => true;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("what handing over would do", () => {
  it("names why the computer isn't the shell's, every bot it restarts, the busy ones, and updates afterwards — and changes nothing", async () => {
    adoptable();
    const before = JSON.stringify(cli.status);
    expect(await manager().adoptCheck()).toEqual({
      ok: true,
      state: "adoptable",
      reasons: ["elsewhere", "update_flag"],
      bots: ["alice:cc", "alice:cx"],
      busy: ["alice:cx"],
      autoUpdate: true,
    });
    expect(commands()).toEqual([CHECK]);
    expect(JSON.stringify(cli.status)).toBe(before);
  });
  it("is asked of a computer the shell does nothing else to (`foreign`)", async () => {
    adoptable();
    const m = manager();
    expect(await m.updateCli()).toEqual({ ok: false, error: "foreign" });
    expect((await m.adoptCheck()).ok).toBe(true);
  });
  it("passes on the cli's refusals as codes the page words", async () => {
    cli.answers[CHECK] = () =>
      adoptJson({ ok: false, code: "base_differs", detail: "the service here talks to http://127.0.0.1:4100, this mafold to https://api.mafold.ai" }, 1);
    expect(await manager().adoptCheck()).toEqual({
      ok: false,
      error: "base_differs",
      detail: "the service here talks to http://127.0.0.1:4100, this mafold to https://api.mafold.ai",
    });
    cli.answers[CHECK] = () => adoptJson({ ok: false, code: "base_unknown", detail: "started by hand" }, 1);
    expect(await manager().adoptCheck()).toMatchObject({ ok: false, error: "base_unknown" });
    cli.answers[CHECK] = () => adoptJson({ ok: false, code: "something_new" }, 1);
    expect(await manager().adoptCheck()).toEqual({ ok: false, error: "failed" });
  });
  it("is `outdated` on a mafold from before `up --adopt`, and `cli_missing` with none", async () => {
    expect(await manager().adoptCheck()).toMatchObject({ ok: false, error: "outdated" });
    rmSync(exe);
    expect(await manager().adoptCheck()).toEqual({ ok: false, error: "cli_missing" });
  });
});

describe("handing the computer to Mafold", () => {
  it("asks first, naming the bots and updates afterwards, then moves them — counted once the status reads back as the shell's", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted", pid: 901, reasons: ["elsewhere", "update_flag"] });
    };
    const m = manager();
    expect(await m.adopt()).toEqual({ ok: true, adopted: true, bots: ["alice:cc", "alice:cx"], cut: [], autoUpdate: true });
    expect(asked).toEqual([{ kind: "adopt", bots: ["alice:cc", "alice:cx"], autoUpdate: true }]);
    // Checked before the dialog and again after it, then moved.
    expect(commands()).toEqual([CHECK, CHECK, ADOPT]);
    const after = await m.status();
    expect(after.supervisor).toBe("running");
    expect(after.foreign).toBeUndefined();
    // The shell does the rest now: what `foreign` refused works.
    cli.answers["update --check --json"] = () => {
      st().update.checked_at = Math.floor(Date.now() / 1000);
      return { code: 0, stdout: `${JSON.stringify({ ok: true, code: "current", latest: "0.9.151" })}\n`, stderr: "" };
    };
    expect((await m.checkUpdate()).ok).toBe(true);
  });
  it("is given the time the cli's own deadlines need — never stopped halfway through a move", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted" });
    };
    await manager().adopt();
    // 5 min for replies + the stops + the new supervisor + 30 s for the bots.
    expect(cli.timeouts[ADOPT]).toBeGreaterThanOrEqual(7 * 60_000);
  });
  it("says which bots' replies were cut off after the 5 minutes", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted", cut: ["alice:cx"] });
    };
    expect(await manager().adopt()).toMatchObject({ ok: true, adopted: true, cut: ["alice:cx"] });
  });
  it("with updates off as this computer's setting, the dialog says they stay off — and that is what reads back", async () => {
    st().update.auto_update_setting = false;
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted" });
    };
    expect(await manager().adopt()).toMatchObject({ ok: true, adopted: true, autoUpdate: false });
    expect(asked).toEqual([{ kind: "adopt", bots: ["alice:cc", "alice:cx"], autoUpdate: false }]);
  });
  it("no in the dialog: nothing moved", async () => {
    adoptable();
    answer = () => false;
    cli.answers[ADOPT] = () => {
      throw new Error("must not run");
    };
    expect(await manager().adopt()).toEqual({ ok: false, error: "cancelled" });
    expect(commands()).toEqual([CHECK]);
    expect(st().supervisor.registered_exe).toBe(OTHER);
  });
  it("`changed`, nothing moved, when the computer isn't what the person agreed to by the time they say yes", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      throw new Error("must not run");
    };
    // A bot added in a terminal while the dialog was up.
    answer = () => {
      (st().daemons as Status[]).push({ name: "alice:new", running: true, pid: 4300 });
      return true;
    };
    expect(await manager().adopt()).toMatchObject({ ok: false, error: "changed" });
    // The update setting turned off meanwhile: the dialog promised updates on.
    cli.ran = [];
    cli.status = foreign();
    answer = () => {
      st().update.auto_update_setting = false;
      return true;
    };
    expect(await manager().adopt()).toMatchObject({ ok: false, error: "changed" });
    expect(commands()).toEqual([CHECK, CHECK]);
  });
  it("who is busy changing under the dialog is not a change: the cli waits for their replies", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted" });
    };
    answer = () => {
      (st().daemons as Status[])[1].busy = false;
      (st().daemons as Status[])[0].busy = true;
      return true;
    };
    expect(await manager().adopt()).toMatchObject({ ok: true, adopted: true });
  });
  it("asks nothing of a computer that is the shell's already, or runs no bots", async () => {
    cli.answers[CHECK] = () => adoptJson({ code: "managed", reasons: [] });
    expect(await manager().adopt()).toEqual({ ok: true, adopted: false, bots: [], cut: [], autoUpdate: true });
    cli.answers[CHECK] = () => adoptJson({ code: "not_set_up", reasons: [], bots: [] });
    expect(await manager().adopt()).toEqual({ ok: false, error: "not_set_up" });
    expect(asked).toEqual([]);
    expect(commands()).toEqual([CHECK, CHECK]);
  });
  it("refused by the cli before the dialog: nothing asked, nothing moved", async () => {
    cli.answers[CHECK] = () => adoptJson({ ok: false, code: "base_differs", detail: "another Mafold" }, 1);
    expect(await manager().adopt()).toEqual({ ok: false, error: "base_differs", detail: "another Mafold" });
    expect(asked).toEqual([]);
    expect(commands()).toEqual([CHECK]);
  });
  it("`unverified` when the cli says done but the status doesn't read back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    adoptable();
    // Said, not done.
    cli.answers[ADOPT] = () => adoptJson({ code: "adopted" });
    const p = manager().adopt();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toMatchObject({ ok: false, error: "unverified" });
  });
  it("`unverified` when a bot still runs as the process from before (it never moved)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      (st().daemons as Status[])[0].pid = 4100;
      return adoptJson({ code: "adopted" });
    };
    const p = manager().adopt();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toMatchObject({ ok: false, error: "unverified" });
  });
  it("`unverified` when updates don't read back as the dialog said", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      st().update.auto_update = false; // still the flag's, say
      return adoptJson({ code: "adopted" });
    };
    const p = manager().adopt();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toMatchObject({ ok: false, error: "unverified" });
  });
  it("moved but not all the way: the cli's own words for it", async () => {
    adoptable();
    cli.answers[ADOPT] = () => adoptJson({ ok: false, code: "bots_not_back", detail: "not running again after 30s: alice:cx" }, 2);
    expect(await manager().adopt()).toEqual({ ok: false, error: "bots_not_back", detail: "not running again after 30s: alice:cx" });
    cli.answers[ADOPT] = () => adoptJson({ ok: false, code: "not_registered", detail: "running, but not registered to start on login" }, 2);
    expect(await manager().adopt()).toMatchObject({ ok: false, error: "not_registered" });
    cli.answers[ADOPT] = () => adoptJson({ ok: false, code: "inside_bot" }, 1);
    expect(await manager().adopt()).toEqual({ ok: false, error: "inside_bot" });
    cli.answers[ADOPT] = () => ({ code: 1, stdout: "", stderr: "Error: boom\n" });
    expect(await manager().adopt()).toEqual({ ok: false, error: "failed", detail: "Error: boom" });
    // Partway: the old supervisor and its bots stopped, the new one not up — how far it got, as said.
    cli.answers[ADOPT] = () => {
      st().supervisor = { running: false, autostart: false, registered_exe: null, registered_exe_canonical: null, no_auto_update: null, not_ours: [] };
      return adoptJson({ ok: false, code: "failed", detail: "the old supervisor and its bots are stopped, but the supervisor didn't start in 15s" }, 1);
    };
    expect(await manager().adopt()).toEqual({
      ok: false,
      error: "failed",
      detail: "the old supervisor and its bots are stopped, but the supervisor didn't start in 15s",
    });
  });
  it("the shell's already by the time it runs: nothing moved, read back as running", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "managed", reasons: [] });
    };
    expect(await manager().adopt()).toEqual({ ok: true, adopted: false, bots: [], cut: [], autoUpdate: true });
    // Said so, but nothing runs here: not taken on its word.
    cli.status = foreign();
    cli.answers[ADOPT] = () => {
      st().supervisor = { running: false, autostart: false, registered_exe: null, registered_exe_canonical: null, no_auto_update: null, not_ours: [] };
      return adoptJson({ code: "managed", reasons: [] });
    };
    expect(await manager().adopt()).toMatchObject({ ok: false, error: "unverified" });
  });
});

describe("one thing at a time", () => {
  it("while the dialog is up, nothing else the shell does starts — and a second hand-over is `busy`", async () => {
    adoptable();
    let yes!: (v: boolean) => void;
    answer = () => new Promise<boolean>((res) => (yes = res));
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted" });
    };
    const m = manager();
    const p = m.adopt();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(await m.adopt()).toEqual({ ok: false, error: "busy" });
    expect(await m.adoptCheck()).toEqual({ ok: false, error: "busy" });
    expect(await m.enable("alice")).toEqual({ error: "busy" });
    expect(await m.disable("alice")).toEqual({ ok: false, error: "busy" });
    expect(await m.rollbackCheck()).toEqual({ ok: false, error: "busy" });
    yes(true);
    expect(await p).toMatchObject({ ok: true, adopted: true });
    expect(commands()).toEqual([CHECK, CHECK, ADOPT]);
  });
  it("held while the bots move and until they read back — an update can't restart the supervisor being replaced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    adoptable();
    let done!: () => void;
    cli.answers[ADOPT] = () =>
      new Promise<Ran>(
        (res) =>
          (done = () => {
            // The cli is done; the status catches up a few seconds later.
            setTimeout(moved, 3_000);
            res(adoptJson({ code: "adopted" }));
          }),
      );
    const m = manager();
    const p = m.adopt();
    await vi.waitFor(() => expect(commands()).toContain(ADOPT));
    const others = async () => [await m.updateCli(), await m.setAutoUpdate(false), await m.adoptCheck(), await m.rollbackCheck(), await m.enable("alice")];
    const busy = [{ ok: false, error: "busy" }, { ok: false, error: "busy" }, { ok: false, error: "busy" }, { ok: false, error: "busy" }, { error: "busy" }];
    // The move under way.
    expect(await others()).toEqual(busy);
    done();
    // Said done, not read back yet.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await others()).toEqual(busy);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ ok: true, adopted: true });
    expect(commands().filter((c) => c !== CHECK && c !== ADOPT)).toEqual([]);
  });
  it("taken before the first await: two asks at the same moment, one runs", async () => {
    adoptable();
    cli.answers[ADOPT] = () => {
      moved();
      return adoptJson({ code: "adopted" });
    };
    const m = manager();
    const [a, b] = await Promise.all([m.adopt(), m.adopt()]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b]).toContainEqual({ ok: false, error: "busy" });
  });
  it("not while an install waits for the supervisor to restart onto it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 });
    // The shell's own computer, updating: the supervisor hasn't moved onto 0.9.152 yet.
    cli.status = foreign();
    st().supervisor = { running: true, pid: 901, autostart: true, registered_exe: exe, registered_exe_canonical: exe, no_auto_update: false, not_ours: [], version: "0.9.151" };
    st().update.auto_update = true;
    cli.answers["update --json"] = () => {
      st().version = "0.9.152";
      return { code: 0, stdout: `${JSON.stringify({ ok: true, code: "updated", latest: "0.9.152", moving: true })}\n`, stderr: "" };
    };
    const m = manager();
    const install = m.updateCli();
    await vi.waitFor(() => expect(commands()).toContain("update --json"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await m.adopt()).toEqual({ ok: false, error: "busy" });
    st().supervisor.version = "0.9.152";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await install).toMatchObject({ ok: true, supervisor: "on_it" });
    expect(commands()).not.toContain(CHECK);
  });
});

describe("the read-back rules", () => {
  const s = (o: Partial<DaemonStatus>): DaemonStatus => ({
    cli: { installed: true, version: "0.9.151" },
    supervisor: "running",
    accounts: ["alice"],
    bots: [{ name: "alice:cc", harness: "claude-code", running: true, busy: false, pid: 5100 }],
    harnesses: [],
    vault: "cached",
    task: null,
    update: { channel: "stable", autoUpdate: true },
    ...o,
  });
  const asked = { bots: ["alice:cc"], before: { "alice:cc": 4100 }, autoUpdate: true };
  it("the shell's, running, each bot a new process, updates as agreed", () => {
    expect(adoptReadsBack(asked, s({}))).toBe(true);
    expect(adoptReadsBack(asked, s({ supervisor: "foreign" }))).toBe(false);
    expect(adoptReadsBack(asked, s({ supervisor: "stopped" }))).toBe(false);
    expect(adoptReadsBack(asked, s({ bots: [{ name: "alice:cc", harness: "claude-code", running: true, busy: false, pid: 4100 }] }))).toBe(false);
    expect(adoptReadsBack(asked, s({ bots: [{ name: "alice:cc", harness: "claude-code", running: false, busy: false }] }))).toBe(false);
    expect(adoptReadsBack(asked, s({ bots: [] }))).toBe(false);
    expect(adoptReadsBack(asked, s({ update: { channel: "stable", autoUpdate: false } }))).toBe(false);
    expect(adoptReadsBack(asked, s({ update: undefined }))).toBe(false);
    // Not running before: running now is enough.
    expect(adoptReadsBack({ ...asked, before: {} }, s({}))).toBe(true);
  });
  it("a check that doesn't say whether it updates itself afterwards can't be put to the person", () => {
    const r = (o: object): Ran => ({ code: 0, stdout: `${JSON.stringify({ ok: true, code: "adoptable", reasons: [], bots: [], ...o })}\n`, stderr: "" });
    expect(readAdoptCheck(r({}))).toMatchObject({ ok: false, error: "failed" });
    expect(readAdoptCheck(r({ auto_update: "yes" }))).toMatchObject({ ok: false, error: "failed" });
    expect(readAdoptCheck(r({ auto_update: false }))).toEqual({ ok: true, state: "adoptable", reasons: [], bots: [], busy: [], autoUpdate: false });
    // A newer cli's reason arrives as it said it; a bot without a name doesn't.
    expect(readAdoptCheck(r({ auto_update: true, reasons: ["elsewhere", "later_reason", 3], bots: [{ name: "a:b" }, { pid: 3 }] }))).toEqual({
      ok: true,
      state: "adoptable",
      reasons: ["elsewhere", "later_reason"],
      bots: ["a:b"],
      busy: [],
      autoUpdate: true,
    });
  });
  it("the same computer: the same bots in any order, the same updates afterwards", () => {
    const c = (bots: string[], autoUpdate = true, busy: string[] = []) => ({ ok: true as const, state: "adoptable" as const, reasons: [], bots, busy, autoUpdate });
    expect(sameAdopt(c(["a", "b"]), c(["b", "a"], true, ["a"]))).toBe(true);
    expect(sameAdopt(c(["a", "b"]), c(["a"]))).toBe(false);
    expect(sameAdopt(c(["a"]), c(["a"], false))).toBe(false);
  });
});

describe("the hand-over dialog's words", () => {
  const table = JSON.parse(readFileSync(join(__dirname, "../static/strings.json"), "utf8")) as StringTable;
  it("are the build's own, naming the bots — and saying how updates will be afterwards", () => {
    const en = new Strings(table, "en");
    const on = confirmText({ kind: "adopt", bots: ["alice:cc", "alice:cx"], autoUpdate: true }, (k, v) => en.frozen(k, v));
    expect(on.message).toBe("Let Mafold manage this computer?");
    expect(on.detail).toBe(
      "From now on you start, stop and update it here, and automatic updates will be on.\n\nReplies being written finish first (up to 5 minutes), then these bots restart once: alice:cc, alice:cx",
    );
    expect(on.ok).toBe("Hand over");
    const off = confirmText({ kind: "adopt", bots: ["alice:cc"], autoUpdate: false }, (k, v) => en.frozen(k, v));
    expect(off.detail).toContain("automatic updates will be off");
    expect(off.detail).not.toContain("will be on");
    expect(off.detail.endsWith(": alice:cc")).toBe(true);
    const zh = new Strings(table, "zh-CN");
    expect(confirmText({ kind: "adopt", bots: ["alice:cc"], autoUpdate: true }, (k, v) => zh.frozen(k, v)).detail).toBe(
      "以后在这里开停、升级，自动升级会是打开的。\n\n先等正在写的回复写完（最多 5 分钟），下面这些 bot 再各重启一次：alice:cc",
    );
    expect(confirmText({ kind: "adopt", bots: ["alice:cc"], autoUpdate: false }, (k, v) => zh.frozen(k, v)).detail).toContain("自动升级会是关着的");
    // No bots: no waiting for replies, no restarts promised.
    const none = confirmText({ kind: "adopt", bots: [], autoUpdate: true }, (k, v) => en.frozen(k, v));
    expect(none.detail).toBe("From now on you start, stop and update it here, and automatic updates will be on.");
    expect(confirmText({ kind: "adopt", bots: [], autoUpdate: false }, (k, v) => zh.frozen(k, v)).detail).not.toContain("重启");
  });
  it("can't be rewritten by the page", () => {
    const s = new Strings(table, "en");
    s.setLocale("en", { "desktop.adopt.detail": "Nothing will restart. {bots}", "desktop.adopt.title": "Free upgrade?" });
    const t = confirmText({ kind: "adopt", bots: ["alice:cc"], autoUpdate: true }, (k, v) => s.frozen(k, v));
    expect(t.message).toBe("Let Mafold manage this computer?");
    expect(t.detail).toContain("restart once");
  });
});
