import { describe, expect, it } from "vitest";

import { isForeign, isUsername, lastJson, parseShellEnv, shellEnvScript, toDaemonStatus, ENV_MARKER, type CliStatus } from "../src/main/daemon/model";

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
