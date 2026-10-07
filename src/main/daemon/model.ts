// What the shell reads from mafold-cli and how it judges it — pure, so the
// rules that decide whether the shell may touch this computer's supervisor
// are unit-tested without a cli or a machine (test/daemon.spec.ts).

import type { DaemonStatus } from "../../shared/desktopHost.generated";

/** `mafold status --json` (mafold-cli supervisor.rs `status_json`), as far as
 *  the shell reads it. Every field optional: an older cli says less. */
export interface CliStatus {
  version?: string;
  exe?: string | null;
  exe_canonical?: string | null;
  supervisor?: {
    running?: boolean;
    pid?: number | null;
    autostart?: boolean;
    registered_exe?: string | null;
    registered_exe_canonical?: string | null;
    no_auto_update?: boolean | null;
  };
  accounts?: string[];
  daemons?: { name?: string; harness?: string; running?: boolean; busy?: boolean }[];
  harnesses?: { id?: string; available?: boolean; version?: string | null }[];
  vault?: string;
}

/** The last JSON object a command printed (other lines are notes for people). */
export function lastJson<T>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * May the shell start / stop this computer's supervisor?
 *
 * Only if the service is registered to the binary the shell manages, without
 * flags the shell would not pass. `mafold up` re-registers the service against
 * the CALLER's binary whenever the flags differ — so an `up` here, against a
 * service someone set up from another install (a dev build, a hand-installed
 * cli with `--no-auto-update`), would take it and every bot on it over.
 * A supervisor that is running with no service registered at all was started
 * by hand; that is someone else's too.
 */
export function isForeign(raw: CliStatus, managedExe: string): boolean {
  const sup = raw.supervisor ?? {};
  const registered = sup.registered_exe_canonical ?? sup.registered_exe ?? null;
  if (registered && registered !== managedExe) return true;
  if (registered && sup.no_auto_update === true) return true;
  if (!registered && sup.running) return true;
  return false;
}

export function toDaemonStatus(raw: CliStatus | null, managedExe: string, task: DaemonStatus["task"]): DaemonStatus {
  if (!raw) {
    return { cli: { installed: false }, supervisor: "absent", accounts: [], bots: [], harnesses: [], vault: "none", task };
  }
  const sup = raw.supervisor ?? {};
  const registered = sup.registered_exe_canonical ?? sup.registered_exe ?? null;
  const supervisor: DaemonStatus["supervisor"] = isForeign(raw, managedExe)
    ? "foreign"
    : sup.running
      ? "running"
      : registered || sup.autostart
        ? "stopped"
        : "absent";
  const vault = raw.vault === "cached" || raw.vault === "device" ? raw.vault : "none";
  return {
    cli: { installed: true, version: raw.version },
    supervisor,
    accounts: (raw.accounts ?? []).filter((a): a is string => typeof a === "string"),
    bots: (raw.daemons ?? [])
      .filter((d) => typeof d.name === "string")
      .map((d) => ({ name: d.name as string, harness: d.harness ?? "claude-code", running: !!d.running, busy: !!d.busy })),
    harnesses: (raw.harnesses ?? [])
      .filter((h) => typeof h.id === "string")
      .map((h) => ({ id: h.id as string, available: !!h.available, version: h.version ?? undefined })),
    vault,
    task,
  };
}

/** The variables the cli needs from the person's login shell. An app started
 *  from Finder gets launchd's bare PATH; the supervisor freezes whatever PATH
 *  `up` ran with into its service, and then cannot find `claude` or `codex`.
 *  Proxies matter for the same reason (people in mainland China set them in
 *  their shell profile). */
export const SHELL_VARS = ["PATH", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"] as const;

export const ENV_MARKER = "__MAFOLD_SHELL_ENV__";

/** The command run in the login shell: a marker (so profile chatter printed
 *  before it is ignored), then each variable NUL-separated. */
export const shellEnvScript = (): string =>
  `printf '${ENV_MARKER}'; printf '%s\\0' ${SHELL_VARS.map((v) => `"$${v}"`).join(" ")}`;

export function parseShellEnv(out: string): Record<string, string> {
  const at = out.lastIndexOf(ENV_MARKER);
  if (at < 0) return {};
  const values = out.slice(at + ENV_MARKER.length).split("\0");
  const env: Record<string, string> = {};
  SHELL_VARS.forEach((name, i) => {
    const v = values[i];
    if (v) env[name] = v;
  });
  return env;
}

/** Usernames compare case-insensitively everywhere in Mafold. */
export const sameAccount = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** What a page may pass as an account name. */
export const isUsername = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(v);
