// mafold-cli's own updates, driven from the desktop against a stand-in cli
// (activity center D5): a check, the newest release installed, automatic
// updates and the channel as settings, and a rollback the person confirms
// natively. Each counts only once this computer's own `status --json` reads it
// back — the version on disk, a rollback's skip, the setting, the supervisor
// running the new binary — never on what the cli printed.
//
// The cli is stood in for at the module the manager runs it through
// (`daemon/cli.ts`): `status` answers from a status this test holds, and every
// other command from `cli.answers`, which may change that status first.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonStatus } from "../src/shared/desktopHost.generated";
import { Strings, type StringTable } from "../src/main/i18n";
// `vi.mock` below is hoisted above this import: the manager gets the stand-in.
import { confirmText, DaemonManager, type Confirm } from "../src/main/daemon/manager";

type Ran = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Status = Record<string, any>;

const cli = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  ran: [] as string[][],
  answers: {} as Record<string, () => Ran | Promise<Ran>>,
  /** Runs on every `status` read — the supervisor coming back on its own time. */
  onStatus: null as null | (() => void),
}));

vi.mock("../src/main/daemon/cli", () => ({
  canonicalExe: (p: { exe: string }) => p.exe,
  ensureInstalled: async () => {},
  runCli: async (_p: unknown, _env: unknown, args: string[]) => {
    cli.ran.push(args);
    if (args[0] === "status") {
      cli.onStatus?.();
      return { code: 0, stdout: `${JSON.stringify(cli.status)}\n`, stderr: "" };
    }
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
let answer = true;
let emitted: DaemonStatus[] = [];

const st = (): Status => cli.status as Status;
const status = (): Status => ({
  version: "0.9.151",
  supervisor: { running: true, registered_exe_canonical: exe, no_auto_update: false, not_ours: [], version: "0.9.151" },
  accounts: ["alice"],
  daemons: [{ name: "alice:cc", running: true, pid: 4100 }],
  harnesses: [{ id: "claude-code", available: true }],
  issues: [],
  update: { channel: "stable", auto_update: true, auto_update_setting: true, checked_at: 1, available: null, failed: null, skipped: null },
});
const says = (o: object, code = 0): Ran => ({ code, stdout: `a line for people\n${JSON.stringify(o)}\n`, stderr: "" });
/** A check the cli got an answer to: noted where `status` reads it, as mafold-cli's `note_looked` does. */
const looked = () => (st().update.checked_at = Math.floor(Date.now() / 1000));
/** What `update --json` prints alongside its code, as mafold-cli says it. */
const upd = (o: object, code = 0) => says({ ok: true, version: st().version, channel: st().update.channel, auto_update: st().update.auto_update_setting, ...o }, code);

const manager = () =>
  new DaemonManager({
    paths: { home: dir, exe, bundled: null },
    env: async () => ({}),
    confirm: async (a) => {
      asked.push(a);
      return answer;
    },
    emit: (s) => emitted.push(s),
    openExternal: () => false,
    emitLogs: () => {},
    saveAs: async () => null,
  });

const commands = () => cli.ran.filter((a) => a[0] !== "status").map((a) => a.join(" "));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mafold-desktop-d5-"));
  exe = join(dir, "mafold");
  writeFileSync(exe, "");
  cli.status = status();
  cli.ran = [];
  cli.answers = {};
  cli.onStatus = null;
  asked = [];
  answer = true;
  emitted = [];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("checking for an update", () => {
  it("says what the feed offers, and installs nothing", async () => {
    cli.answers["update --check --json"] = () => {
      st().update.available = "0.9.152";
      looked();
      return upd({ code: "available", latest: "0.9.152" });
    };
    expect(await manager().checkUpdate()).toEqual({
      ok: true,
      latest: "0.9.152",
      update: { channel: "stable", autoUpdate: true, autoUpdateSetting: true, available: "0.9.152", checkedAt: st().update.checked_at },
    });
    expect(commands()).toEqual(["update --check --json"]);
  });
  it("is `unverified` when the cli says it checked but the status shows no check since", async () => {
    cli.answers["update --check --json"] = () => upd({ code: "available", latest: "0.9.152" });
    expect(await manager().checkUpdate()).toMatchObject({ ok: false, error: "unverified" });
  });
  it("says why not: the feed couldn't be asked, or the mafold here is from before checks", async () => {
    cli.answers["update --check --json"] = () => upd({ ok: false, code: "failed", detail: "error sending request" }, 1);
    expect(await manager().checkUpdate()).toEqual({ ok: false, error: "failed", detail: "error sending request" });
    delete cli.answers["update --check --json"];
    expect(await manager().checkUpdate()).toMatchObject({ ok: false, error: "outdated" });
  });
  it("one at a time: a second ask while one runs is told the shell is busy", async () => {
    let release!: () => void;
    cli.answers["update --check --json"] = () =>
      new Promise<Ran>(
        (res) =>
          (release = () => {
            looked();
            res(upd({ code: "current", latest: "0.9.151" }));
          }),
      );
    const m = manager();
    const first = m.checkUpdate();
    expect(await m.checkUpdate()).toEqual({ ok: false, error: "busy" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    expect(await first).toMatchObject({ ok: true, latest: "0.9.151" });
    expect(commands()).toEqual(["update --check --json"]);
  });
});

describe("automatic updates and the channel, as settings", () => {
  it("turns automatic updates off — and the computer stays the shell's to manage", async () => {
    cli.answers["update --auto-update off --json"] = () => {
      Object.assign(st().update, { auto_update: false, auto_update_setting: false });
      return upd({ code: "set" });
    };
    const m = manager();
    expect(await m.setAutoUpdate(false)).toMatchObject({ ok: true, update: { autoUpdate: false, autoUpdateSetting: false } });
    const s = await m.status();
    expect(s.supervisor).toBe("running");
    expect(s.foreign).toBeUndefined();
  });
  it("is `unverified` when the cli says set but the setting doesn't read back", async () => {
    cli.answers["update --auto-update off --json"] = () => upd({ code: "set" });
    expect(await manager().setAutoUpdate(false)).toMatchObject({ ok: false, error: "unverified" });
  });
  it("switches the channel and says what it offers — switched even when that check fails", async () => {
    cli.answers["update --channel dev --check --json"] = () => {
      st().update.channel = "dev";
      looked();
      return upd({ code: "available", latest: "0.9.152-dev.7" });
    };
    expect(await manager().setChannel("dev")).toMatchObject({ ok: true, latest: "0.9.152-dev.7", update: { channel: "dev" } });
    // What a check offered is passed on only once that check reads back too.
    st().update.checked_at = 1;
    cli.answers["update --channel dev --check --json"] = () => upd({ code: "available", latest: "0.9.152-dev.8" });
    expect("latest" in (await manager().setChannel("dev"))).toBe(false);

    cli.answers["update --channel stable --check --json"] = () => {
      st().update.channel = "stable";
      return upd({ ok: false, code: "failed", detail: "error sending request" }, 1);
    };
    const back = await manager().setChannel("stable");
    expect(back).toMatchObject({ ok: true, update: { channel: "stable" } });
    expect("latest" in back).toBe(false);
  });
  it("takes only a channel it knows", async () => {
    expect(await manager().setChannel("beta")).toEqual({ ok: false, error: "refused" });
    expect(cli.ran).toEqual([]);
  });
});

describe("a supervisor that isn't the shell's", () => {
  it("is left alone: nothing about its updates is asked or changed", async () => {
    st().supervisor = { running: true, registered_exe_canonical: "/opt/homebrew/bin/mafold", not_ours: ["elsewhere"], version: "0.9.140" };
    const m = manager();
    expect(await m.checkUpdate()).toEqual({ ok: false, error: "foreign" });
    expect(await m.setAutoUpdate(true)).toEqual({ ok: false, error: "foreign" });
    expect(await m.setChannel("dev")).toEqual({ ok: false, error: "foreign" });
    expect(await m.updateCli()).toEqual({ ok: false, error: "foreign" });
    expect(await m.rollbackCheck()).toEqual({ ok: false, error: "foreign" });
    expect(await m.rollback()).toEqual({ ok: false, error: "foreign" });
    expect(commands()).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("installing the newest release", () => {
  const installs = (to: string, moving: boolean, onDisk = true) => {
    cli.answers["update --json"] = () => {
      if (onDisk) st().version = to;
      return upd({ code: "updated", latest: to, restart: "…", moving });
    };
  };

  it("counts once the new version is on disk and the supervisor runs it — after the replies it was writing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    installs("0.9.152", true);
    let looks = 0;
    cli.onStatus = () => {
      // The supervisor finishes its replies, then comes back on the new binary.
      if (st().version === "0.9.152" && ++looks === 6) st().supervisor.version = "0.9.152";
    };
    const done = manager().updateCli();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await done).toEqual({ ok: true, version: "0.9.152", updated: true, supervisor: "on_it" });
    // The page heard it while it waited: on disk first, then running.
    const seen = emitted.map((s) => `${s.cli.version}/${s.cli.running}`);
    expect(seen).toContain("0.9.152/0.9.151");
    expect(seen[seen.length - 1]).toBe("0.9.152/0.9.152");
  });
  it("another install or rollback waits for the supervisor to come back on the last one; a check doesn't", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    installs("0.9.152", true);
    cli.answers["update --check --json"] = () => (looked(), upd({ code: "current", latest: "0.9.152" }));
    const m = manager();
    const first = m.updateCli();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await m.updateCli()).toEqual({ ok: false, error: "busy" });
    expect(await m.rollback()).toEqual({ ok: false, error: "busy" });
    expect(await m.checkUpdate()).toMatchObject({ ok: true });
    st().supervisor.version = "0.9.152";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toMatchObject({ ok: true, supervisor: "on_it" });
    expect(commands().filter((c) => c === "update --json" || c.startsWith("rollback"))).toEqual(["update --json"]);
  });
  it("on a computer no release is built for, a cli from before `--json` isn't run at all", async () => {
    st().update.supported = false;
    cli.answers.update = () => ({ code: 0, stdout: "no mafold release is built for your platform\n", stderr: "" });
    expect(await manager().updateCli()).toEqual({ ok: false, error: "unsupported" });
    expect(commands()).toEqual([]);
  });
  it("is `not_restarted` when the supervisor never moves onto it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    installs("0.9.152", true);
    const done = manager().updateCli();
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(await done).toMatchObject({ ok: false, error: "not_restarted" });
  });
  it("is `unverified` when the cli says installed but the version on disk didn't change", async () => {
    installs("0.9.152", true, false);
    expect(await manager().updateCli()).toMatchObject({ ok: false, error: "unverified" });
  });
  it("already the newest: said so, nothing restarted", async () => {
    cli.answers["update --json"] = () => upd({ code: "current" });
    expect(await manager().updateCli()).toEqual({ ok: true, version: "0.9.151", updated: false, supervisor: "on_it" });
  });
  it("with nothing running, the bots start on it; a supervisor that takes no restart requests keeps its version for now", async () => {
    st().supervisor.running = false;
    installs("0.9.152", false);
    expect(await manager().updateCli()).toEqual({ ok: true, version: "0.9.152", updated: true, supervisor: "none" });

    cli.status = status();
    installs("0.9.153", false);
    expect(await manager().updateCli()).toEqual({ ok: true, version: "0.9.153", updated: true, supervisor: "later" });
  });
  it("a mafold from before `update --json` gets the plain update, read back by its version", async () => {
    cli.answers.update = () => {
      st().version = "0.9.148";
      return { code: 0, stdout: "✓ updated to v0.9.148\n", stderr: "" };
    };
    st().version = "0.9.140";
    expect(await manager().updateCli()).toEqual({ ok: true, version: "0.9.148", updated: true, supervisor: "later" });
    expect(commands()).toEqual(["update --json", "update"]);
  });
  it("says what failed, and that the cli didn't answer in time", async () => {
    cli.answers["update --json"] = () => upd({ ok: false, code: "failed", detail: "checksum mismatch" }, 1);
    expect(await manager().updateCli()).toEqual({ ok: false, error: "failed", detail: "checksum mismatch" });
    cli.answers["update --json"] = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    expect(await manager().updateCli()).toMatchObject({ ok: false, error: "timeout" });
    cli.answers["update --json"] = () => upd({ ok: false, code: "unsupported" });
    expect(await manager().updateCli()).toEqual({ ok: false, error: "unsupported" });
  });
});

describe("going back to the earlier version", () => {
  const possible = () => {
    cli.answers["rollback --check --json"] = () => says({ ok: true, code: "possible", from: "0.9.152", to: "0.9.151", sticks: true });
  };
  const rollsBack = ({ skip = true, moving = true, comesBack = true } = {}) => {
    cli.answers["rollback --json"] = () => {
      st().version = "0.9.151";
      if (skip) st().update.skipped = { version: "0.9.152", at: 1760000000 };
      if (comesBack) st().supervisor.version = "0.9.151";
      return says({ ok: true, code: "rolled_back", from: "0.9.152", to: "0.9.151", sticks: true, restart: "…", moving });
    };
  };
  beforeEach(() => {
    Object.assign(st(), { version: "0.9.152" });
    st().supervisor.version = "0.9.152";
  });
  afterEach(() => {
    // Never `--force`: an earlier binary that can't keep the skip gets no rollback.
    expect(commands().filter((c) => c.includes("--force"))).toEqual([]);
  });

  it("asks natively, naming both versions, then counts once the earlier one runs with the one left skipped", async () => {
    possible();
    rollsBack();
    expect(await manager().rollbackCheck()).toEqual({ ok: true, from: "0.9.152", to: "0.9.151" });
    expect(await manager().rollback()).toEqual({ ok: true, version: "0.9.151", updated: true, supervisor: "on_it" });
    expect(asked).toEqual([{ kind: "rollback", version: "0.9.151", skipped: "0.9.152" }]);
    // Asked once for the button, once before the dialog, and again after it.
    expect(commands()).toEqual(["rollback --check --json", "rollback --check --json", "rollback --check --json", "rollback --json"]);
  });
  it("only the versions the dialog named: an update that landed while it was up stops it (`changed`)", async () => {
    possible();
    rollsBack();
    let shown = 0;
    const m = new DaemonManager({
      paths: { home: dir, exe, bundled: null },
      env: async () => ({}),
      confirm: async (a) => {
        asked.push(a);
        // While the person reads it, automatic updates put 0.9.153 in, keeping 0.9.152 as the earlier one.
        if (shown++ === 0) cli.answers["rollback --check --json"] = () => says({ ok: true, code: "possible", from: "0.9.153", to: "0.9.152", sticks: true });
        return true;
      },
      emit: () => {},
      openExternal: () => false,
      emitLogs: () => {},
      saveAs: async () => null,
    });
    expect(await m.rollback()).toMatchObject({ ok: false, error: "changed" });
    expect(commands().filter((c) => c === "rollback --json")).toEqual([]);
  });
  it("is `unverified` when the skip didn't reach the disk — it would update straight back", async () => {
    possible();
    rollsBack({ skip: false });
    expect(await manager().rollback()).toMatchObject({ ok: false, error: "unverified" });
  });
  it("no in the dialog: nothing rolled back", async () => {
    possible();
    rollsBack();
    answer = false;
    expect(await manager().rollback()).toEqual({ ok: false, error: "cancelled" });
    expect(commands()).toEqual(["rollback --check --json"]);
    expect(st().version).toBe("0.9.152");
  });
  it("offers nothing — and asks nothing — when the earlier version can't keep it, or there is none", async () => {
    cli.answers["rollback --check --json"] = () => says({ ok: false, code: "too_old", from: "0.9.152", to: "0.9.140", sticks: false });
    expect(await manager().rollback()).toEqual({ ok: false, error: "too_old" });
    cli.answers["rollback --check --json"] = () => says({ ok: false, code: "no_backup", from: "0.9.152", to: null, sticks: false });
    expect(await manager().rollback()).toEqual({ ok: false, error: "no_backup" });
    delete cli.answers["rollback --check --json"];
    expect(await manager().rollback()).toMatchObject({ ok: false, error: "outdated" });
    expect(asked).toEqual([]);
    expect(commands().filter((c) => c === "rollback --json")).toEqual([]);
  });
  it("waits for the supervisor to come back on it, like an install", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    possible();
    rollsBack({ comesBack: false });
    let looks = 0;
    cli.onStatus = () => {
      if (st().update.skipped && ++looks === 4) st().supervisor.version = "0.9.151";
    };
    const done = manager().rollback();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await done).toEqual({ ok: true, version: "0.9.151", updated: true, supervisor: "on_it" });
  });
});

describe("sharing the shell with starting and stopping the bots", () => {
  it("an update asked while the start or stop dialog is up is told busy, not run alongside", async () => {
    let say!: (yes: boolean) => void;
    const m = new DaemonManager({
      paths: { home: dir, exe, bundled: null },
      env: async () => ({}),
      confirm: () => new Promise<boolean>((res) => (say = res)),
      emit: () => {},
      openExternal: () => false,
      emitLogs: () => {},
      saveAs: async () => null,
    });
    for (const start of [() => m.disable("alice"), () => m.enable("alice")]) {
      const pending = start();
      await vi.waitFor(() => expect(say).toBeTypeOf("function"));
      expect(await m.checkUpdate()).toEqual({ ok: false, error: "busy" });
      expect(await m.updateCli()).toEqual({ ok: false, error: "busy" });
      say(false);
      expect(await pending).toMatchObject({ error: "cancelled" });
      say = undefined as unknown as (yes: boolean) => void;
    }
    // Given back after the no: an update goes ahead.
    cli.answers["update --check --json"] = () => (looked(), upd({ code: "current", latest: "0.9.151" }));
    expect(await m.checkUpdate()).toMatchObject({ ok: true });
    expect(commands()).toEqual(["update --check --json"]);
  });
});

describe("the rollback dialog's words", () => {
  const table = JSON.parse(readFileSync(join(__dirname, "../static/strings.json"), "utf8")) as StringTable;
  const ask: Confirm = { kind: "rollback", version: "0.9.151", skipped: "0.9.152" };

  it("come from the build's own strings, both versions named", () => {
    const en = new Strings(table, "en");
    const text = confirmText(ask, (k, v) => en.frozen(k, v));
    expect(text.message).toBe("Go back to 0.9.151?");
    expect(text.detail.startsWith("0.9.152 is skipped")).toBe(true);
    expect(text.ok).toBe("Roll back");
    const zh = new Strings(table, "zh-CN");
    expect(confirmText(ask, (k, v) => zh.frozen(k, v)).message).toBe("回到 0.9.151？");
  });
  it("can't be rewritten by the page", () => {
    const s = new Strings(table, "en");
    s.setLocale("en", { "desktop.rollback.title": "Install this totally fine thing?" });
    expect(s.t("desktop.rollback.title", { version: "x" })).toBe("Install this totally fine thing?");
    expect(confirmText(ask, (k, v) => s.frozen(k, v)).message).toBe("Go back to 0.9.151?");
  });
});
