// "Run bots on this computer": the shell installs mafold-cli, signs it in as
// the person, gets it the connections key, and starts its supervisor — and
// stops it again. It never runs the supervisor itself (that stays a system
// service the cli owns: closing the app does not stop the bots), and it never
// touches a supervisor it does not manage (model.ts `isForeign`).
//
// enable(username):
//   confirm (native dialog) → install the cli if missing
//   → already signed in here? skip : `login --device-json --no-up`, hand the
//     device code to the page, which approves it as the signed-in person
//   → `connection unlock --json` until the key arrives (another device of the
//     person's hands it over; the page this shell shows is one of them)
//   → `up`

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import type { DaemonEnableResult, DaemonStatus } from "../../shared/desktopHost.generated";
import { log } from "../log";
import { canonicalExe, ensureInstalled, runCli, spawnCli, type CliPaths } from "./cli";
import { lastJson, sameAccount, toDaemonStatus, type CliStatus } from "./model";

export interface DaemonDeps {
  paths: CliPaths;
  env(): Promise<NodeJS.ProcessEnv>;
  /** Ask the person in a native dialog the page cannot answer. */
  confirm(kind: "enable" | "disable", vars: { handle: string; everyone: boolean }): Promise<boolean>;
  /** The page wants to hear about it. */
  emit(status: DaemonStatus): void;
}

const UNLOCK_EVERY_MS = 10_000;
const UNLOCK_FOR_MS = 10 * 60_000;
const LOGIN_CODE_WAIT_MS = 60_000;

export class DaemonManager {
  private task: DaemonStatus["task"] = null;
  private lastSent = "";
  private login: ChildProcess | null = null;
  private busy = false;

  constructor(private deps: DaemonDeps) {}

  async status(): Promise<DaemonStatus> {
    let raw: CliStatus | null = null;
    let outdated = false;
    if (existsSync(this.deps.paths.exe)) {
      try {
        const env = await this.deps.env();
        const r = await runCli(this.deps.paths, env, ["status", "--json"], 20_000);
        raw = r.code === 0 ? lastJson<CliStatus>(r.stdout) : null;
        // A mafold from before `status --json` answers the flag with clap's
        // usage error. It is installed — just too old to be read.
        outdated = !raw && /unexpected argument|unrecognized|wasn't expected/i.test(r.stderr);
      } catch {
        raw = null;
      }
    }
    const s = toDaemonStatus(raw, canonicalExe(this.deps.paths), this.task);
    return outdated ? { ...s, cli: { installed: true, outdated: true } } : s;
  }

  /** Read the status and tell the page if it changed. */
  async refresh(): Promise<DaemonStatus> {
    const s = await this.status();
    const key = JSON.stringify(s);
    if (key !== this.lastSent) {
      this.lastSent = key;
      this.deps.emit(s);
    }
    return s;
  }

  private setTask(task: DaemonStatus["task"]): void {
    this.task = task;
    void this.refresh();
  }

  async enable(username: string): Promise<DaemonEnableResult> {
    if (this.busy) return { error: "busy" };
    const before = await this.status();
    if (before.supervisor === "foreign") return { error: "foreign" };
    if (!(await this.deps.confirm("enable", { handle: username, everyone: false }))) return { error: "cancelled" };
    this.busy = true;
    try {
      const env = await this.deps.env();
      this.setTask({ step: "install" });
      await ensureInstalled(this.deps.paths, env);
      let now = await this.status();
      // An existing mafold older than this shell's needs: bring it up to date
      // the cli's own way (checksummed, with a rollback copy) before reading it.
      if (now.cli.outdated) {
        const u = await runCli(this.deps.paths, env, ["update"], 5 * 60_000);
        if (u.code !== 0) throw new Error(`mafold update failed: ${u.stderr.trim() || u.code}`);
        now = await this.status();
        if (now.cli.outdated) throw new Error("mafold is too old to be managed here — run `mafold update`");
      }
      if (now.supervisor === "foreign") {
        this.busy = false;
        this.setTask(null);
        return { error: "foreign" };
      }
      if (now.accounts.some((a) => sameAccount(a, username))) {
        void this.finish();
        return { ready: true };
      }
      this.setTask({ step: "login" });
      return await this.startLogin(env);
    } catch (e) {
      this.busy = false;
      const error = e instanceof Error ? e.message : String(e);
      log("enable failed:", error);
      this.setTask({ step: "install", error });
      return { error };
    }
  }

  /** `login --device-json --no-up`: resolve with the code as soon as it is
   *  printed; the rest of the sign-in carries on in the background. */
  private startLogin(env: NodeJS.ProcessEnv): Promise<DaemonEnableResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: DaemonEnableResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const child = spawnCli(this.deps.paths, env, ["login", "--device-json", "--no-up"]);
      this.login = child;
      const timer = setTimeout(() => {
        settle({ error: "the sign-in did not start" });
        child.kill();
      }, LOGIN_CODE_WAIT_MS);
      let buffer = "";
      let approved = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          let ev: { event?: string; user_code?: string } = {};
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.event === "code" && ev.user_code) {
            clearTimeout(timer);
            settle({ userCode: ev.user_code });
          } else if (ev.event === "approved") {
            approved = true;
            void this.finish();
          }
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        this.login = null;
        if (!settled) settle({ error: `the sign-in ended early (${code})` });
        // Expired, refused or killed before anyone approved: nothing more is
        // coming, so free the manager and say what happened.
        if (!approved) {
          this.busy = false;
          this.setTask({ step: "login", error: code === 0 ? "ended" : "expired" });
        }
      });
    });
  }

  /** Signed in: get the connections key, then start the supervisor. */
  private async finish(): Promise<void> {
    try {
      const env = await this.deps.env();
      this.setTask({ step: "unlock" });
      const deadline = Date.now() + UNLOCK_FOR_MS;
      for (;;) {
        const r = await runCli(this.deps.paths, env, ["connection", "unlock", "--json"], 60_000);
        const state = lastJson<{ state?: string }>(r.stdout)?.state;
        // Bots run without connections too: an error or a key that never comes
        // is not a reason to leave the computer offline.
        if (state !== "waiting" || Date.now() > deadline) break;
        await new Promise((res) => setTimeout(res, UNLOCK_EVERY_MS));
      }
      const before = await this.status();
      if (before.supervisor === "foreign") throw new Error("foreign");
      this.setTask({ step: "start" });
      const up = await runCli(this.deps.paths, env, ["up"], 120_000);
      if (up.code !== 0) throw new Error(up.stderr.trim() || `mafold up exited ${up.code}`);
      this.busy = false;
      this.setTask(null);
    } catch (e) {
      this.busy = false;
      const error = e instanceof Error ? e.message : String(e);
      log("finish failed:", error);
      this.setTask({ step: "start", error });
    }
  }

  async disable(username: string): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: "busy" };
    const s = await this.status();
    if (s.supervisor === "foreign") return { ok: false, error: "foreign" };
    if (!s.cli.installed) return { ok: true };
    // The supervisor serves everyone signed in here: with one account (or only
    // this one) stopping it is the request; with others, sign just this one out.
    const others = s.accounts.filter((a) => !sameAccount(a, username));
    const everyone = others.length === 0;
    if (!(await this.deps.confirm("disable", { handle: username, everyone }))) return { ok: false, error: "cancelled" };
    this.busy = true;
    try {
      const env = await this.deps.env();
      this.setTask({ step: "stop" });
      const r = everyone
        ? await runCli(this.deps.paths, env, ["down"], 120_000)
        : await runCli(this.deps.paths, env, ["account", "rm", username], 60_000);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      this.busy = false;
      this.setTask(null);
      return { ok: true };
    } catch (e) {
      this.busy = false;
      const error = e instanceof Error ? e.message : String(e);
      this.setTask({ step: "stop", error });
      return { ok: false, error };
    }
  }

  /** Stop a sign-in that is still waiting (the app is quitting). */
  dispose(): void {
    this.login?.kill();
  }
}
