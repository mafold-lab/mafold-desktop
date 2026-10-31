import { describe, expect, it } from "vitest";

import {
  actionOutcome,
  cliRefused,
  cliSaid,
  foreignWhy,
  isChannel,
  isForeign,
  isOwnBot,
  isSignInUrl,
  isUsername,
  lastJson,
  ownerOf,
  parseShellEnv,
  readBack,
  readRestart,
  readRollbackCheck,
  readRuntimeLoginLine,
  readsBack,
  runtimeReadsBack,
  sameVersion,
  shellEnvScript,
  signedOut,
  supervisorOn,
  toDaemonStatus,
  versionReadsBack,
  ENV_MARKER,
  type CliStatus,
} from "../src/main/daemon/model";

const MANAGED = "/Users/a/.mafold/mafold";
const st = (sup: CliStatus["supervisor"], extra: Partial<CliStatus> = {}): CliStatus => ({ version: "0.9.140", supervisor: sup, ...extra });

describe("whose supervisor is this", () => {
  it("is ours when the service runs the binary we manage, with no extra flags", () => {
    expect(isForeign(st({ running: true, registered_exe_canonical: MANAGED, no_auto_update: false }), MANAGED)).toBe(false);
    expect(isForeign(st({ running: false, registered_exe_canonical: null }), MANAGED)).toBe(false);
  });
  it("is someone else's when the service runs another binary", () => {
    expect(isForeign(st({ running: true, registered_exe_canonical: "/Users/a/dev/mafold/target/release/mafold" }), MANAGED)).toBe(true);
  });
  it("is someone else's when it was registered with --no-auto-update (we never are)", () => {
    expect(isForeign(st({ running: true, registered_exe_canonical: MANAGED, no_auto_update: true }), MANAGED)).toBe(true);
  });
  it("is someone else's when it runs with no service at all (started by hand)", () => {
    expect(isForeign(st({ running: true, registered_exe: null }), MANAGED)).toBe(true);
  });
  it("falls back to the registered path when the canonical one is missing (older cli)", () => {
    expect(isForeign(st({ running: true, registered_exe: MANAGED }), MANAGED)).toBe(false);
  });
});

// Activity center D5: "managed from the command line" says why, and turning
// automatic updates off as a setting is no longer one of the reasons.
describe("why the supervisor here isn't the shell's", () => {
  const OTHER = "/opt/homebrew/bin/mafold";
  it("says each reason, one at a time", () => {
    expect(foreignWhy(st({ running: true, registered_exe_canonical: OTHER }), MANAGED)).toEqual(["elsewhere"]);
    expect(foreignWhy(st({ running: true, registered_exe: null }), MANAGED)).toEqual(["by_hand"]);
    expect(foreignWhy(st({ running: true, registered_exe_canonical: MANAGED, no_auto_update: true }), MANAGED)).toEqual(["update_flag"]);
    // …and the page hears them with `foreign`.
    const s = toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED, no_auto_update: true }), MANAGED, null);
    expect(s).toMatchObject({ supervisor: "foreign", foreign: ["update_flag"] });
  });
  it("is the shell's with automatic updates turned off as a setting", () => {
    const off = st(
      { running: true, registered_exe_canonical: MANAGED, no_auto_update: false, not_ours: [] },
      { update: { channel: "stable", auto_update: false, auto_update_setting: false } },
    );
    expect(foreignWhy(off, MANAGED)).toEqual([]);
    const s = toDaemonStatus(off, MANAGED, null);
    expect(s.supervisor).toBe("running");
    expect("foreign" in s).toBe(false);
    expect(s.update).toMatchObject({ autoUpdate: false, autoUpdateSetting: false });
  });
  it("takes a newer cli's reasons as said, a reason it doesn't know included, in the cli's order", () => {
    expect(foreignWhy(st({ running: true, registered_exe_canonical: OTHER, no_auto_update: true, not_ours: ["update_flag", "elsewhere"] }), MANAGED)).toEqual([
      "elsewhere",
      "update_flag",
    ]);
    // Registered but not loaded, running anyway: only the cli can tell.
    expect(foreignWhy(st({ running: true, registered_exe_canonical: MANAGED, not_ours: ["by_hand"] }), MANAGED)).toEqual(["by_hand"]);
    expect(foreignWhy(st({ running: true, registered_exe_canonical: MANAGED, not_ours: ["from_a_newer_cli"] }), MANAGED)).toEqual(["from_a_newer_cli"]);
    expect(toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED, not_ours: ["from_a_newer_cli"] }), MANAGED, null).supervisor).toBe("foreign");
  });
  it("still holds its own reading when a cli says nothing is wrong", () => {
    expect(foreignWhy(st({ running: true, registered_exe_canonical: OTHER, not_ours: [] }), MANAGED)).toEqual(["elsewhere"]);
  });
  it("says nothing when the supervisor is the shell's, or nothing is set up", () => {
    expect(foreignWhy(st({ running: true, registered_exe_canonical: MANAGED, no_auto_update: false }), MANAGED)).toEqual([]);
    expect(foreignWhy(st({ running: false }), MANAGED)).toEqual([]);
    expect("foreign" in toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED }), MANAGED, null)).toBe(false);
  });
  it("on Windows, reads the cli's `\\\\?\\C:\\…` as the shell's `C:\\…`, in any case — and another binary still as elsewhere", () => {
    const win = "C:\\Users\\bob\\.mafold\\mafold.exe";
    expect(foreignWhy(st({ running: true, registered_exe_canonical: "\\\\?\\C:\\Users\\bob\\.mafold\\mafold.exe" }), win)).toEqual([]);
    expect(foreignWhy(st({ running: true, registered_exe_canonical: "\\\\?\\c:\\users\\BOB\\.mafold\\MAFOLD.EXE" }), win)).toEqual([]);
    expect(foreignWhy(st({ running: true, registered_exe_canonical: "\\\\?\\UNC\\srv\\share\\mafold.exe" }), "\\\\srv\\share\\mafold.exe")).toEqual([]);
    expect(foreignWhy(st({ running: true, registered_exe_canonical: "\\\\?\\C:\\dev\\mafold\\target\\release\\mafold.exe" }), win)).toEqual(["elsewhere"]);
    // Unix paths keep their case.
    expect(foreignWhy(st({ running: true, registered_exe_canonical: MANAGED.toUpperCase() }), MANAGED)).toEqual(["elsewhere"]);
  });
});

describe("toDaemonStatus", () => {
  it("says absent when there is no cli", () => {
    expect(toDaemonStatus(null, MANAGED, null)).toMatchObject({ cli: { installed: false }, supervisor: "absent", accounts: [] });
  });
  it("reads running / stopped / absent / foreign", () => {
    expect(toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED }), MANAGED, null).supervisor).toBe("running");
    expect(toDaemonStatus(st({ running: false, registered_exe_canonical: MANAGED }), MANAGED, null).supervisor).toBe("stopped");
    expect(toDaemonStatus(st({ running: false, autostart: false }), MANAGED, null).supervisor).toBe("absent");
    expect(toDaemonStatus(st({ running: true, registered_exe_canonical: "/x" }), MANAGED, null).supervisor).toBe("foreign");
  });
  it("keeps only well-formed rows", () => {
    const s = toDaemonStatus(
      st({}, {
        accounts: ["alice", 3 as unknown as string],
        daemons: [{ name: "alice:cc", running: true }, { harness: "codex" }],
        harnesses: [{ id: "claude-code", available: true, version: "2.1" }, { available: true }],
        vault: "weird",
      }),
      MANAGED,
      { step: "unlock" },
    );
    expect(s.accounts).toEqual(["alice"]);
    expect(s.bots).toEqual([{ name: "alice:cc", harness: "claude-code", running: true, busy: false }]);
    expect(s.harnesses).toEqual([{ id: "claude-code", available: true, version: "2.1" }]);
    expect(s.vault).toBe("none");
    expect(s.task).toEqual({ step: "unlock" });
  });
  // Activity center D1: a runtime's login state was read by the cli and then
  // dropped here, so the page could never say "Claude Code is signed out".
  it("passes on what a newer cli says — runtime health, what needs a person, its updates", () => {
    const s = toDaemonStatus(
      st({ running: true, registered_exe_canonical: MANAGED }, {
        daemons: [{ name: "alice:cc", running: true, busy: true, turn_since: 1760000100 }],
        harnesses: [
          {
            id: "claude-code",
            available: true,
            version: "2.1",
            health: {
              state: "exhausted",
              checked_at: 1760000001,
              limits: [{ kind: "session", label: "5h", percent: 100, resets_at: 1760003600 }, { label: "no kind" }],
            },
          },
          { id: "codex", available: true, health: { checked_at: 5 } },
        ],
        issues: [
          { code: "runtime_exhausted", scope: "runtime", subject: "claude-code", bots: ["alice:cc"], until: 1760003600 },
          { code: "service_stopped", scope: "machine" },
          { code: "from_a_newer_cli", scope: "galaxy" },
          { scope: "bot" },
        ],
        update: { channel: "stable", auto_update: true, available: "0.9.150", failed: { version: "0.9.150", error: "disk full", since: 9 } },
      }),
      MANAGED,
      null,
    );
    expect(s.bots[0]).toMatchObject({ name: "alice:cc", busy: true, turnSince: 1760000100 });
    expect(s.harnesses[0].health).toEqual({
      state: "exhausted",
      checkedAt: 1760000001,
      limits: [{ kind: "session", label: "5h", percent: 100, resetsAt: 1760003600 }],
    });
    expect(s.harnesses[1]).toEqual({ id: "codex", available: true, version: undefined });
    expect(s.issues).toEqual([
      { code: "runtime_exhausted", scope: "runtime", subject: "claude-code", bots: ["alice:cc"], until: 1760003600 },
      { code: "service_stopped", scope: "machine" },
    ]);
    expect(s.update).toEqual({ channel: "stable", autoUpdate: true, available: "0.9.150", failed: { version: "0.9.150", error: "disk full", since: 9 } });
  });
  it("leaves out what an older cli doesn't say — not said is not 'nothing wrong'", () => {
    const s = toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED }, { harnesses: [{ id: "claude-code", available: true }] }), MANAGED, null);
    expect("issues" in s).toBe(false);
    expect("update" in s).toBe(false);
    expect("health" in s.harnesses[0]).toBe(false);
    // An empty list from a cli that does say is "nothing wrong".
    expect(toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED }, { issues: [] }), MANAGED, null).issues).toEqual([]);
  });
});

describe("restarting a bot", () => {
  const status = (bots: CliStatus["daemons"], extra: Partial<CliStatus> = {}) => toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED }, { daemons: bots, ...extra }), MANAGED, null);
  const cli = (json: object | null, code = 0, stderr = "") => ({ code, stdout: json ? `${JSON.stringify(json)}\n` : "", stderr });

  it("passes on each bot's process and this computer's id", () => {
    const s = status([{ name: "alice:cc", running: true, pid: 4100 }, { name: "alice:cx", running: false, pid: null }], { device_id: "dev-1" });
    expect(s.deviceId).toBe("dev-1");
    expect(s.bots).toEqual([
      { name: "alice:cc", harness: "claude-code", running: true, busy: false, pid: 4100 },
      { name: "alice:cx", harness: "claude-code", running: false, busy: false },
    ]);
    expect(status([]).deviceId).toBeUndefined();
  });
  it("reads what `mafold restart --json` came to", () => {
    expect(readRestart(cli({ ok: true, code: "restarted", name: "alice:cc", old_pid: 4100, new_pid: 4200, interrupted: 2 }))).toEqual({ ok: true, oldPid: 4100, newPid: 4200, interrupted: 2 });
    expect(readRestart(cli({ ok: true, code: "restarted", name: "alice:cc", new_pid: 4200, interrupted: 0 }))).toEqual({ ok: true, newPid: 4200, interrupted: 0 });
    expect(readRestart(cli({ ok: false, code: "supervisor_too_old", detail: "from before" }, 1))).toEqual({ ok: false, error: "supervisor_too_old", detail: "from before" });
    expect(readRestart(cli({ ok: false, code: "unverified" }, 2))).toEqual({ ok: false, error: "unverified" });
    // A code from a newer cli, or a success without the pid to read back: not a success.
    expect(readRestart(cli({ ok: false, code: "paused" }, 1))).toEqual({ ok: false, error: "failed" });
    expect(readRestart(cli({ ok: true, code: "restarted" }))).toEqual({ ok: false, error: "failed" });
  });
  it("says a mafold from before `restart` is outdated", () => {
    expect(readRestart(cli(null, 2, "error: unrecognized subcommand 'restart'\n"))).toEqual({ ok: false, error: "outdated" });
    expect(readRestart(cli(null, 101, "thread panicked"))).toEqual({ ok: false, error: "failed", detail: "thread panicked" });
  });
  it("counts it only once its own status shows the new process running", () => {
    const said = { ok: true as const, oldPid: 4100, newPid: 4200, interrupted: 0 };
    expect(readBack(said, "alice:cc", status([{ name: "alice:cc", running: true, pid: 4200 }]))).toEqual(said);
    expect(readBack(said, "alice:cc", status([{ name: "alice:cc", running: true, pid: 4100 }]))).toMatchObject({ ok: false, error: "unverified" });
    expect(readBack(said, "alice:cc", status([{ name: "alice:cc", running: false }]))).toMatchObject({ ok: false, error: "unverified" });
    expect(readBack({ ok: false, error: "exited" }, "alice:cc", status([]))).toEqual({ ok: false, error: "exited" });
  });
});

// Activity center D2: a start or stop counted on the command's exit code — a
// `mafold up` that exited 0 with nothing running said done; one that ran fine
// and exited 1 said «没能完成:mafold up exited 1».
describe("starting and stopping read back", () => {
  const status = (supervisor: "running" | "stopped" | "absent" | "foreign", accounts: string[]) =>
    toDaemonStatus(
      st({ running: supervisor === "running" || supervisor === "foreign", registered_exe_canonical: supervisor === "foreign" ? "/x" : supervisor === "absent" ? null : MANAGED, autostart: supervisor !== "absent" }, { accounts }),
      MANAGED,
      null,
    );

  it("a start counts once it runs with the person signed in", () => {
    expect(readsBack({ start: "Alice" }, status("running", ["alice"]))).toBe(true);
    expect(readsBack({ start: "alice" }, status("running", ["bob"])), "someone else's sign-in").toBe(false);
    expect(readsBack({ start: "alice" }, status("stopped", ["alice"]))).toBe(false);
    expect(readsBack({ start: "alice" }, status("foreign", ["alice"])), "another install's service").toBe(false);
  });

  it("a stop counts once it's stopped — or, one of several people, that one signed out", () => {
    expect(readsBack({ stop: "alice", everyone: true }, status("stopped", ["alice"]))).toBe(true);
    expect(readsBack({ stop: "alice", everyone: true }, status("absent", []))).toBe(true);
    expect(readsBack({ stop: "alice", everyone: true }, status("running", ["alice"]))).toBe(false);
    expect(readsBack({ stop: "alice", everyone: false }, status("running", ["bob"]))).toBe(true);
    expect(readsBack({ stop: "Alice", everyone: false }, status("running", ["alice", "bob"]))).toBe(false);
  });

  it("what read back decides, not the exit code", () => {
    expect(actionOutcome({ code: 1, stderr: "warning: something" }, true), "exited 1, but it runs: done").toBeNull();
    expect(actionOutcome({ code: 0, stderr: "" }, false)).toEqual({
      error: "unverified",
      detail: "the command finished, but this computer's status didn't change",
    });
    expect(actionOutcome({ code: 1, stderr: "Error: the supervisor didn't start within 15s" }, false)).toEqual({
      error: "failed",
      detail: "Error: the supervisor didn't start within 15s",
    });
    expect(actionOutcome({ code: 1, stderr: "", timedOut: true }, false)).toEqual({ error: "timeout", detail: "exit 1" });
  });

  it("what a command printed goes to the log as `detail`, never as the code", () => {
    const o = actionOutcome({ code: 1, stderr: "mafold up exited 1" }, false);
    expect(o?.error).toBe("failed");
    expect(o?.detail).toBe("mafold up exited 1");
  });
});

// Activity center D3: restarting a bot, signing Mafold in again, signing
// Claude Code in — the rules each reads back by.
describe("the person's own, signed in again", () => {
  const status = (extra: Partial<CliStatus> = {}) => toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED }, extra), MANAGED, null);
  const refused = (who: string) => ({ code: "mafold_signed_out", scope: "account", subject: who, accounts: [who] });

  it("a bot is its handle's owner's", () => {
    expect(ownerOf("alice:cc")).toBe("alice");
    expect(ownerOf("cc")).toBeNull();
    expect(ownerOf(":cc")).toBeNull();
    expect(isOwnBot("alice:cc", "Alice")).toBe(true);
    expect(isOwnBot("bob:cc", "alice")).toBe(false);
    expect(isOwnBot("alicex:cc", "alice"), "a prefix of a name is not the name").toBe(false);
  });

  it("signed in again: still signed in here, and no longer refused", () => {
    expect(readsBack({ relogin: "alice" }, status({ accounts: ["alice"], issues: [] }))).toBe(true);
    expect(readsBack({ relogin: "alice" }, status({ accounts: ["alice"], issues: [refused("alice")] }))).toBe(false);
    expect(readsBack({ relogin: "alice" }, status({ accounts: ["alice"], issues: [refused("bob")] })), "someone else's refusal").toBe(true);
    expect(readsBack({ relogin: "alice" }, status({ accounts: ["bob"], issues: [] })), "not signed in here").toBe(false);
    expect(signedOut("Alice", status({ accounts: ["alice"], issues: [refused("alice")] }))).toBe(true);
    expect(signedOut("alice", status({ accounts: ["alice"] })), "an older cli says nothing").toBe(false);
  });

  it("reads `runtime login --json` line by line", () => {
    expect(readRuntimeLoginLine('{"event":"started","account":"default","adding":false}')).toEqual({ event: "started" });
    expect(readRuntimeLoginLine('{"event":"link","url":"https://claude.ai/oauth/authorize?x=1"}')).toEqual({ event: "link", url: "https://claude.ai/oauth/authorize?x=1" });
    expect(readRuntimeLoginLine('{"event":"done","now":{"state":"known","email":"a@example.com"}}')).toEqual({ event: "done", email: "a@example.com" });
    expect(readRuntimeLoginLine('{"event":"done","now":{"state":"unknown"}}')).toEqual({ event: "done" });
    expect(readRuntimeLoginLine('{"event":"failed","code":"rejected","detail":"no"}')).toEqual({ event: "failed", error: "rejected", detail: "no" });
    expect(readRuntimeLoginLine('{"event":"failed","code":"spawn"}')).toEqual({ event: "failed", error: "runtime_missing" });
    expect(readRuntimeLoginLine('{"event":"failed","code":"account"}'), "a code the page has no words for").toEqual({ event: "failed", error: "failed" });
    expect(readRuntimeLoginLine("Open this to sign in")).toBeNull();
    expect(readRuntimeLoginLine('{"event":"link"}')).toBeNull();
  });

  it("opens sign-in pages on Anthropic's own hosts only", () => {
    expect(isSignInUrl("https://claude.ai/oauth/authorize?code=true")).toBe(true);
    expect(isSignInUrl("https://console.anthropic.com/oauth/authorize")).toBe(true);
    expect(isSignInUrl("https://claude.com/cai/oauth/authorize")).toBe(true);
    expect(isSignInUrl("http://claude.ai/oauth/authorize"), "not https").toBe(false);
    expect(isSignInUrl("https://claude.ai.example.com/")).toBe(false);
    expect(isSignInUrl("https://evilclaude.ai/")).toBe(false);
    expect(isSignInUrl("not a url")).toBe(false);
  });

  it("a runtime reads back signed in: installed, not signed out, nothing saying it needs signing in", () => {
    const h = (state?: string, available = true) => ({ harnesses: [{ id: "claude-code", available, ...(state ? { health: { state } } : {}) }] });
    expect(runtimeReadsBack("claude-code", status({ ...h("ok"), issues: [] }))).toBe(true);
    expect(runtimeReadsBack("claude-code", status({ ...h(), issues: [] })), "not probed yet, nothing said against it").toBe(true);
    expect(runtimeReadsBack("claude-code", status({ ...h("unauthenticated"), issues: [] }))).toBe(false);
    expect(runtimeReadsBack("claude-code", status({ ...h("ok", false), issues: [] }))).toBe(false);
    expect(
      runtimeReadsBack("claude-code", status({ ...h("unknown"), issues: [{ code: "runtime_signed_out", scope: "runtime", subject: "claude-code" }] })),
    ).toBe(false);
    expect(
      runtimeReadsBack("claude-code", status({ ...h("ok"), issues: [{ code: "runtime_signed_out", scope: "runtime", subject: "codex" }] })),
      "another runtime's",
    ).toBe(true);
  });
});

describe("cli output", () => {
  it("takes the last JSON line and ignores the notes around it", () => {
    expect(lastJson("✓ logged in as alice\n{\"event\":\"code\",\"user_code\":\"AB-12\"}\nnote\n")).toEqual({ event: "code", user_code: "AB-12" });
    expect(lastJson("nothing here")).toBeNull();
  });
});

describe("login shell environment", () => {
  it("reads PATH and proxies after the marker, ignoring profile chatter", () => {
    const out = `Welcome to zsh!\n${ENV_MARKER}/opt/homebrew/bin:/usr/bin\0http://127.0.0.1:7890\0\0\0\0\0\0\0\0`;
    expect(parseShellEnv(out)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", HTTPS_PROXY: "http://127.0.0.1:7890" });
    expect(parseShellEnv("no marker")).toEqual({});
    expect(shellEnvScript()).toContain('"$PATH"');
  });
  it("accepts only account-shaped names from the page", () => {
    expect(isUsername("alice")).toBe(true);
    expect(isUsername("alice; rm -rf /")).toBe(false);
    expect(isUsername("")).toBe(false);
  });
});

describe("mafold-cli's own updates", () => {
  const ours = (extra: Partial<CliStatus> = {}, sup: CliStatus["supervisor"] = {}) =>
    toDaemonStatus(st({ running: true, registered_exe_canonical: MANAGED, ...sup }, extra), MANAGED, null);
  const ran = (json: object | null, code: number | null = 0, stderr = "", timedOut = false) => ({ code, stdout: json ? `a note\n${JSON.stringify(json)}\n` : "", stderr, timedOut });

  it("passes on the running version, the setting, the last check and a rollback's skip", () => {
    const s = ours(
      {
        version: "0.9.151",
        update: { channel: "dev", auto_update: true, auto_update_setting: true, checked_at: 1760000000, available: null, skipped: { version: "0.9.152", at: 1759990000 } },
      },
      { version: "0.9.150" },
    );
    expect(s.cli).toEqual({ installed: true, version: "0.9.151", running: "0.9.150" });
    expect(s.update).toEqual({ channel: "dev", autoUpdate: true, autoUpdateSetting: true, checkedAt: 1760000000, skipped: { version: "0.9.152", at: 1759990000 } });
    // A supervisor that isn't running says no version it runs; a half-written skip is no skip.
    const stopped = toDaemonStatus(st({ running: false, registered_exe_canonical: MANAGED, version: "0.9.150" }, { update: { channel: "stable", auto_update: true, skipped: { at: 3 } } }), MANAGED, null);
    expect(stopped.cli).toEqual({ installed: true, version: "0.9.140" });
    expect(stopped.update).toEqual({ channel: "stable", autoUpdate: true });
  });
  it("reads automatic updates from the setting when nothing runs or is set up to say", () => {
    const s = toDaemonStatus(st({ running: false }, { update: { channel: "stable", auto_update: null, auto_update_setting: false } }), MANAGED, null);
    expect(s.update).toEqual({ channel: "stable", autoUpdate: false, autoUpdateSetting: false });
    // An older cli without the setting, and nothing to say: no update block, as before.
    expect("update" in toDaemonStatus(st({ running: false }, { update: { channel: "stable", auto_update: null } }), MANAGED, null)).toBe(false);
  });
  it("reads what the cli said, or why it said nothing readable", () => {
    expect(cliSaid(ran({ ok: true, code: "available", latest: "0.9.152" }))).toEqual({ ok: true, code: "available", latest: "0.9.152" });
    expect(cliSaid(ran(null, 2, "error: unexpected argument '--check' found\n"))).toMatchObject({ error: "outdated" });
    expect(cliSaid(ran(null, 2, "error: unrecognized subcommand 'rollback'\n"))).toMatchObject({ error: "outdated" });
    expect(cliSaid(ran(null, null, "", true))).toMatchObject({ error: "timeout" });
    expect(cliSaid(ran(null, 1, "boom"))).toEqual({ error: "failed", detail: "boom" });
    // A JSON line without a code is no answer.
    expect(cliSaid(ran({ ok: true }, 1, "boom"))).toMatchObject({ error: "failed" });
    expect(cliRefused({ ok: false, code: "unsupported" })).toEqual({ error: "unsupported" });
    expect(cliRefused({ ok: false, code: "failed", detail: "network down" })).toEqual({ error: "failed", detail: "network down" });
    expect(cliRefused({ ok: false, code: "something_new" })).toEqual({ error: "failed" });
  });
  it("offers a rollback only when it would stick, to a version the earlier binary names", () => {
    expect(readRollbackCheck(ran({ ok: true, code: "possible", from: "0.9.152", to: "0.9.151", sticks: true }))).toEqual({ ok: true, from: "0.9.152", to: "0.9.151" });
    expect(readRollbackCheck(ran({ ok: false, code: "too_old", from: "0.9.152", to: "0.9.140", sticks: false }))).toEqual({ ok: false, error: "too_old" });
    expect(readRollbackCheck(ran({ ok: false, code: "no_backup", from: "0.9.152", to: null, sticks: false }))).toEqual({ ok: false, error: "no_backup" });
    expect(readRollbackCheck(ran({ ok: true, code: "possible", from: "0.9.152", to: null }))).toMatchObject({ ok: false, error: "failed" });
    expect(readRollbackCheck(ran(null, 2, "error: unexpected argument '--check' found"))).toMatchObject({ ok: false, error: "outdated" });
  });
  it("reads back an install by the version on disk, a rollback by that AND the skip", () => {
    const s = ours({ version: "0.9.151", update: { channel: "stable", auto_update: true, auto_update_setting: true, skipped: { version: "0.9.152", at: 9 } } });
    expect(versionReadsBack({ installed: "0.9.151" }, s)).toBe(true);
    expect(versionReadsBack({ installed: "v0.9.151" }, s)).toBe(true);
    expect(versionReadsBack({ installed: "0.9.152" }, s)).toBe(false);
    expect(versionReadsBack({ rolledBack: { from: "0.9.152", to: "0.9.151" } }, s)).toBe(true);
    // The old binary is back, but the skip never reached the disk: it would update straight back.
    const noSkip = ours({ version: "0.9.151", update: { channel: "stable", auto_update: true } });
    expect(versionReadsBack({ rolledBack: { from: "0.9.152", to: "0.9.151" } }, noSkip)).toBe(false);
    expect(versionReadsBack({ autoUpdate: true }, s)).toBe(true);
    expect(versionReadsBack({ autoUpdate: false }, s)).toBe(false);
    expect(versionReadsBack({ channel: "stable" }, s)).toBe(true);
    expect(versionReadsBack({ channel: "dev" }, s)).toBe(false);
    // An older cli that doesn't say the setting doesn't read back as set.
    expect(versionReadsBack({ autoUpdate: true }, ours({ update: { channel: "stable", auto_update: true } }))).toBe(false);
  });
  it("says where the supervisor is with a version", () => {
    expect(supervisorOn("0.9.151", ours({}, { version: "0.9.151" }))).toBe("on_it");
    expect(supervisorOn("0.9.151", ours({}, { version: "0.9.150" }))).toBeNull();
    expect(supervisorOn("0.9.151", ours({}, {}))).toBeNull();
    expect(supervisorOn("0.9.151", toDaemonStatus(st({ running: false, registered_exe_canonical: MANAGED }), MANAGED, null))).toBe("none");
    expect(sameVersion("0.9.151", "v0.9.151")).toBe(true);
    expect(sameVersion(undefined, "0.9.151")).toBe(false);
    expect(sameVersion("0.9.151-dev.3", "0.9.151")).toBe(false);
  });
  it("takes only a channel it knows from the page", () => {
    expect(isChannel("stable")).toBe(true);
    expect(isChannel("dev")).toBe(true);
    expect(isChannel("beta")).toBe(false);
    expect(isChannel(1)).toBe(false);
  });
});
