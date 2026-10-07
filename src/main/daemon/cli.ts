// mafold-cli on this computer, as the shell uses it.
//
// One rule above the others: the shell only ever EXECUTES `~/.mafold/mafold` —
// the same place install.sh / install.ps1 put it — never the copy inside the
// app. The supervisor writes the binary that ran `up` into its service, so a
// service pointed into the app bundle would break the moment the app updated
// or was removed. The bundled copy exists only to be copied there once.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ShellConfig } from "../config";
import { log } from "../log";
import { resourcePath } from "../paths";

export interface CliPaths {
  home: string;
  /** The binary the shell runs (and the supervisor's service will run). */
  exe: string;
  /** The copy shipped inside the app, if there is one. */
  bundled: string | null;
}

export function cliPaths(cfg: ShellConfig, os: "macos" | "windows" | "linux"): CliPaths {
  const home = cfg.test?.mafoldHome ?? join(homedir(), ".mafold");
  const name = os === "windows" ? "mafold.exe" : "mafold";
  const shipped = cfg.test?.cli ?? resourcePath("bin", `${process.platform}-${process.arch}`, name);
  return { home, exe: join(home, name), bundled: existsSync(shipped) ? shipped : null };
}

/** The managed binary as the filesystem resolves it — what `status --json`'s
 *  `registered_exe_canonical` is compared with. */
export const canonicalExe = (p: CliPaths): string => {
  try {
    return realpathSync(p.exe);
  } catch {
    return p.exe;
  }
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(p: CliPaths, env: NodeJS.ProcessEnv, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(p.exe, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export function spawnCli(p: CliPaths, env: NodeJS.ProcessEnv, args: string[]): ChildProcess {
  return spawn(p.exe, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Put the cli in place if it is not there. An existing install is left alone —
 * its supervisor updates it (with checksums and a rollback copy); the shell
 * replacing it underneath would race that.
 */
export async function ensureInstalled(p: CliPaths, env: NodeJS.ProcessEnv): Promise<void> {
  if (existsSync(p.exe)) return;
  if (!p.bundled) throw new Error("this build has no mafold binary to install");
  mkdirSync(p.home, { recursive: true });
  // Copy beside, then rename into place: a half-written binary must never be
  // the one at the path the supervisor will run.
  const tmp = `${p.exe}.installing-${process.pid}`;
  copyFileSync(p.bundled, tmp);
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, p.exe);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
  // macOS: a copied file can carry the quarantine flag. Clear only that — the
  // binary's Developer ID signature stays as the release signed it (unlike
  // install.sh's ad-hoc re-sign, which costs the person their Full Disk Access
  // grants on every update).
  if (process.platform === "darwin") {
    await new Promise<void>((resolve) => execFile("/usr/bin/xattr", ["-d", "com.apple.quarantine", p.exe], () => resolve()));
  }
  const smoke = await runCli(p, env, ["--version"], 30_000);
  if (smoke.code !== 0) throw new Error(`the installed mafold does not run: ${smoke.stderr.trim() || smoke.code}`);
  log("installed mafold:", smoke.stdout.trim());
}
