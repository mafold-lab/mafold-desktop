// What the shell reads from mafold-cli and how it judges it — pure, so the
// rules that decide whether the shell may touch this computer's supervisor
// are unit-tested without a cli or a machine (test/daemon.spec.ts).

import type {
  AdoptCheck,
  AdoptError,
  BotRestartError,
  BotRestartResult,
  CliRollbackCheck,
  CliUpdate,
  CliUpdateError,
  DaemonActionError,
  DaemonStatus,
  MachineIssue,
  RuntimeHealth,
  RuntimeLoginError,
} from "../../shared/desktopHost.generated";

/** `mafold status --json` (mafold-cli supervisor.rs `status_json`), as far as
 *  the shell reads it. Every field optional: an older cli says less. */
export interface CliStatus {
  version?: string;
  exe?: string | null;
  exe_canonical?: string | null;
  device_id?: string | null;
  supervisor?: {
    running?: boolean;
    pid?: number | null;
    autostart?: boolean;
    registered_exe?: string | null;
    registered_exe_canonical?: string | null;
    no_auto_update?: boolean | null;
    /** Why the service isn't this binary's to manage (C10): `elsewhere` ·
     *  `by_hand` · `update_flag`; empty when it is. */
    not_ours?: string[] | null;
    /** The version the running supervisor runs, from its own record (C5). */
    version?: string | null;
  };
  accounts?: string[];
  daemons?: {
    name?: string;
    harness?: string;
    running?: boolean;
    busy?: boolean;
    pid?: number | null;
    turn_since?: number | null;
  }[];
  harnesses?: {
    id?: string;
    available?: boolean;
    version?: string | null;
    health?: {
      state?: string;
      checked_at?: number | null;
      limits?: { kind?: string; label?: string | null; percent?: number | null; resets_at?: number | null }[];
    } | null;
  }[];
  vault?: string;
  issues?: {
    code?: string;
    scope?: string;
    subject?: string | null;
    bots?: string[];
    accounts?: string[];
    since?: number | null;
    until?: number | null;
  }[];
  update?: {
    channel?: string;
    /** Null when nothing runs or is set up to say. */
    auto_update?: boolean | null;
    auto_update_setting?: boolean;
    supported?: boolean;
    checked_at?: number | null;
    available?: string | null;
    failed?: { version?: string; error?: string; since?: number } | null;
    skipped?: { version?: string; at?: number } | null;
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const names = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return list.length ? list : undefined;
};
/** Drop the keys whose value is `undefined`, so an older cli's status reads
 *  exactly as it always did (no `health: undefined` for a deep-equal to trip on). */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** A runtime's health as the page is told it (`RuntimeHealth`). */
function healthOf(h: NonNullable<NonNullable<CliStatus["harnesses"]>[number]["health"]>): RuntimeHealth | undefined {
  const state = str(h.state);
  if (!state) return undefined;
  const limits = (h.limits ?? [])
    .filter((l) => typeof l.kind === "string")
    .map((l) => defined({ kind: l.kind as string, label: str(l.label), percent: num(l.percent), resetsAt: num(l.resets_at) }));
  return defined({ state, checkedAt: num(h.checked_at), limits: limits.length ? limits : undefined });
}

const SCOPES: readonly MachineIssue["scope"][] = ["machine", "account", "runtime", "bot"];

/** What needs a person here, in the cli's order (worst first). A row without
 *  a code or a scope this shell knows is left out, not guessed at. */
function issuesOf(list: NonNullable<CliStatus["issues"]>): MachineIssue[] {
  return list
    .filter((i) => typeof i.code === "string" && SCOPES.includes(i.scope as MachineIssue["scope"]))
    .map((i) =>
      defined({
        code: i.code as string,
        scope: i.scope as MachineIssue["scope"],
        subject: str(i.subject),
        bots: names(i.bots),
        accounts: names(i.accounts),
        since: num(i.since),
        until: num(i.until),
      }),
    );
}

function updateOf(u: NonNullable<CliStatus["update"]>): CliUpdate | undefined {
  const setting = typeof u.auto_update_setting === "boolean" ? u.auto_update_setting : undefined;
  // Nothing runs or is set up here to say whether it updates itself: the
  // supervisor the shell starts (`up`, no flags) follows the setting.
  const autoUpdate = typeof u.auto_update === "boolean" ? u.auto_update : setting;
  if (typeof u.channel !== "string" || autoUpdate === undefined) return undefined;
  const f = u.failed;
  const failed =
    f && typeof f.version === "string" && typeof f.since === "number"
      ? { version: f.version, error: typeof f.error === "string" ? f.error : "", since: f.since }
      : undefined;
  const k = u.skipped;
  const skipped = k && typeof k.version === "string" && k.version && typeof k.at === "number" ? { version: k.version, at: k.at } : undefined;
  return defined({
    channel: u.channel,
    autoUpdate,
    autoUpdateSetting: setting,
    available: str(u.available),
    checkedAt: num(u.checked_at),
    supported: typeof u.supported === "boolean" ? u.supported : undefined,
    failed,
    skipped,
  });
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

/** The reasons in the order the page reads them (mafold-cli's own). */
const FOREIGN_ORDER = ["elsewhere", "by_hand", "update_flag"];

/** A path as Windows names it without the extended-length prefix: mafold-cli
 *  canonicalises with Rust's `fs::canonicalize`, which writes `\\?\C:\…`
 *  (`\\?\UNC\server\…` for a share) where Node's `realpathSync` writes `C:\…`. */
const plainPath = (p: string): string => (p.startsWith("\\\\?\\UNC\\") ? `\\\\${p.slice(8)}` : p.startsWith("\\\\?\\") ? p.slice(4) : p);

/** The same file, as the cli and the shell each canonicalise it — a Windows
 *  path in either prefix form and any case (Windows paths ignore case). */
export function samePath(a: string, b: string): boolean {
  const x = plainPath(a);
  const y = plainPath(b);
  const windows = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  return windows(x) && windows(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Why the shell may NOT start, stop or update this computer's supervisor —
 * none: it may.
 *
 * Only a service registered to the binary the shell manages, without flags
 * the shell would not pass, is its own. `mafold up` re-registers the service
 * against the CALLER's binary whenever the flags differ — so an `up` here,
 * against a service someone set up from another install (a dev build, a
 * hand-installed cli with `--no-auto-update`), would take it and every bot on
 * it over (`elsewhere`, `update_flag`). A supervisor that is running with no
 * service registered at all was started by hand (`by_hand`); that is someone
 * else's too. Automatic updates turned off as a setting (`update
 * --auto-update off`) are none of these: the service stays as registered.
 *
 * A cli that says why (`supervisor.not_ours`, C10) is taken at its word, a
 * reason this shell doesn't know included — and the shell's own reading still
 * holds on top, so a newer cli can only add reasons, never wave one away.
 */
export function foreignWhy(raw: CliStatus, managedExe: string): string[] {
  const sup = raw.supervisor ?? {};
  const registered = sup.registered_exe_canonical ?? sup.registered_exe ?? null;
  const why = new Set<string>();
  if (registered && !samePath(registered, managedExe)) why.add("elsewhere");
  if (!registered && sup.running) why.add("by_hand");
  if (registered && sup.no_auto_update === true) why.add("update_flag");
  for (const c of Array.isArray(sup.not_ours) ? sup.not_ours : []) if (typeof c === "string" && c) why.add(c);
  const rank = (c: string) => (FOREIGN_ORDER.includes(c) ? FOREIGN_ORDER.indexOf(c) : FOREIGN_ORDER.length);
  return [...why].sort((a, b) => rank(a) - rank(b));
}

export const isForeign = (raw: CliStatus, managedExe: string): boolean => foreignWhy(raw, managedExe).length > 0;

export function toDaemonStatus(raw: CliStatus | null, managedExe: string, task: DaemonStatus["task"]): DaemonStatus {
  if (!raw) {
    return { cli: { installed: false }, supervisor: "absent", accounts: [], bots: [], harnesses: [], vault: "none", task };
  }
  const sup = raw.supervisor ?? {};
  const registered = sup.registered_exe_canonical ?? sup.registered_exe ?? null;
  const foreign = foreignWhy(raw, managedExe);
  const supervisor: DaemonStatus["supervisor"] = foreign.length
    ? "foreign"
    : sup.running
      ? "running"
      : registered || sup.autostart
        ? "stopped"
        : "absent";
  const vault = raw.vault === "cached" || raw.vault === "device" ? raw.vault : "none";
  // What a newer cli says beyond the basics goes to the page as it said it —
  // a runtime's login state, what needs a person here, its own updates. The
  // shell judges none of it (activity center D1); absent stays absent.
  const update = raw.update ? updateOf(raw.update) : undefined;
  const running = sup.running ? str(sup.version) : undefined;
  return {
    cli: { installed: true, version: raw.version, ...(running ? { running } : {}) },
    supervisor,
    ...(foreign.length ? { foreign } : {}),
    accounts: (raw.accounts ?? []).filter((a): a is string => typeof a === "string"),
    ...(typeof raw.device_id === "string" && raw.device_id ? { deviceId: raw.device_id } : {}),
    bots: (raw.daemons ?? [])
      .filter((d) => typeof d.name === "string")
      .map((d) => ({
        name: d.name as string,
        harness: d.harness ?? "claude-code",
        running: !!d.running,
        busy: !!d.busy,
        ...(typeof d.pid === "number" ? { pid: d.pid } : {}),
        ...(num(d.turn_since) !== undefined ? { turnSince: d.turn_since as number } : {}),
      })),
    harnesses: (raw.harnesses ?? [])
      .filter((h) => typeof h.id === "string")
      .map((h) => {
        const health = h.health ? healthOf(h.health) : undefined;
        return { id: h.id as string, available: !!h.available, version: h.version ?? undefined, ...(health ? { health } : {}) };
      }),
    ...(Array.isArray(raw.issues) ? { issues: issuesOf(raw.issues) } : {}),
    ...(update ? { update } : {}),
    vault,
    task,
  };
}

/** `mafold restart <name> --json` (mafold-cli supervisor.rs `Restart`). */
interface CliRestart {
  ok?: boolean;
  code?: string;
  detail?: string;
  old_pid?: number;
  new_pid?: number;
  interrupted?: number;
}

const RESTART_ERRORS: readonly BotRestartError[] = [
  "unverified", "unknown_bot", "no_supervisor", "supervisor_too_old", "not_taken", "still_running", "exited", "failed",
];

/** What `mafold restart --json` came to, as the page is told it. A mafold
 *  from before `restart` answers with clap's usage error: `outdated`. */
export function readRestart(r: { code: number | null; stdout: string; stderr: string }): BotRestartResult {
  const said = lastJson<CliRestart>(r.stdout);
  if (!said) {
    if (/unrecognized subcommand|unexpected argument/i.test(r.stderr)) return { ok: false, error: "outdated" };
    return { ok: false, error: "failed", detail: r.stderr.trim().slice(0, 300) || `exit ${r.code}` };
  }
  if (said.ok === true && said.code === "restarted" && typeof said.new_pid === "number") {
    return {
      ok: true,
      ...(typeof said.old_pid === "number" ? { oldPid: said.old_pid } : {}),
      newPid: said.new_pid,
      interrupted: typeof said.interrupted === "number" ? said.interrupted : 0,
    };
  }
  const error = RESTART_ERRORS.find((e) => e === said.code) ?? "failed";
  return { ok: false, error, ...(said.detail ? { detail: said.detail } : {}) };
}

/** The shell's own read-back: the bot runs, as the process the cli said it
 *  started. A restart the cli counted but this can't see is `unverified`. */
export function readBack(said: BotRestartResult, name: string, after: DaemonStatus): BotRestartResult {
  if (!said.ok) return said;
  const bot = after.bots.find((b) => b.name === name);
  if (bot?.running && bot.pid === said.newPid) return said;
  return { ok: false, error: "unverified", detail: `restarted as pid ${said.newPid}, but this computer's status shows ${bot?.pid ?? "no running process"}` };
}

/**
 * Starting and stopping the bots here count only once this computer's status
 * reads back as asked (activity center D2) — a command's exit code was the
 * judge, so a `mafold up` that exited 0 with nothing running said done, and
 * one that ran fine but exited 1 said "mafold up exited 1".
 */
export type Asked = { start: string } | { stop: string; everyone: boolean } | { relogin: string };

/** Does `s` read back as `asked`: running with the person signed in; stopped
 *  (or never set up); or, stopping one of several people, that person gone;
 *  or signed in again, Mafold no longer refusing the login? */
export function readsBack(asked: Asked, s: DaemonStatus): boolean {
  if ("start" in asked) return s.supervisor === "running" && s.accounts.some((a) => sameAccount(a, asked.start));
  if ("relogin" in asked) return s.accounts.some((a) => sameAccount(a, asked.relogin)) && !signedOut(asked.relogin, s);
  if (asked.everyone) return s.supervisor === "stopped" || s.supervisor === "absent";
  return !s.accounts.some((a) => sameAccount(a, asked.stop));
}

/** Does this computer say Mafold refused `username`'s login here
 *  (`mafold_signed_out`)? An older cli says nothing: not refused. */
export function signedOut(username: string, s: DaemonStatus): boolean {
  return (s.issues ?? []).some(
    (i) => i.code === "mafold_signed_out" && ((!!i.subject && sameAccount(i.subject, username)) || !!i.accounts?.some((a) => sameAccount(a, username))),
  );
}

/** Whose bot `handle` is: Mafold names a bot `owner:bot`. */
export function ownerOf(handle: string): string | null {
  const at = handle.indexOf(":");
  return at > 0 ? handle.slice(0, at) : null;
}

export const isOwnBot = (handle: string, username: string): boolean => {
  const owner = ownerOf(handle);
  return !!owner && sameAccount(owner, username);
};

/** The runtimes the shell signs in (mafold-cli `runtime login`). */
export const SIGN_IN_RUNTIMES: readonly string[] = ["claude-code"];

/** One line of `mafold runtime login <runtime> --json` (mafold-cli
 *  runtime_login.rs), as far as the shell acts on it. */
export type RuntimeLoginEvent =
  | { event: "started" }
  | { event: "link"; url: string }
  | { event: "done"; email?: string }
  | { event: "failed"; error: RuntimeLoginError; detail?: string };

/** The cli's failure codes, as the page is told them. */
const RUNTIME_LOGIN_FAILURES: Record<string, RuntimeLoginError> = {
  spawn: "runtime_missing",
  no_link: "no_link",
  no_code: "no_code",
  cancelled: "cancelled",
  rejected: "rejected",
};

export function readRuntimeLoginLine(line: string): RuntimeLoginEvent | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let ev: { event?: unknown; url?: unknown; code?: unknown; detail?: unknown; now?: { email?: unknown } };
  try {
    ev = JSON.parse(text);
  } catch {
    return null;
  }
  switch (ev.event) {
    case "started":
      return { event: "started" };
    case "link":
      return typeof ev.url === "string" ? { event: "link", url: ev.url } : null;
    case "done": {
      const email = str(ev.now?.email);
      return email ? { event: "done", email } : { event: "done" };
    }
    case "failed": {
      const error = (typeof ev.code === "string" && RUNTIME_LOGIN_FAILURES[ev.code]) || "failed";
      const detail = str(ev.detail);
      return detail ? { event: "failed", error, detail } : { event: "failed", error };
    }
    default:
      return null;
  }
}

/** A sign-in page the shell opens in the system browser: https on Anthropic's
 *  own hosts. Anything else the runtime printed is shown, never opened. */
export function isSignInUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && ["claude.ai", "claude.com", "anthropic.com"].some((d) => host === d || host.endsWith(`.${d}`));
}

/** Does `s` read back `runtime` as signed in: installed, its health not
 *  "signed out", and no issue saying it needs signing in? */
export function runtimeReadsBack(runtime: string, s: DaemonStatus): boolean {
  const h = s.harnesses.find((x) => x.id === runtime);
  if (!h?.available || h.health?.state === "unauthenticated") return false;
  return !(s.issues ?? []).some((i) => (i.code === "runtime_signed_out" || i.code === "runtime_missing") && i.subject === runtime);
}

/** What a start or stop came to: nothing wrong once the status read back as
 *  asked, whatever the command exited with; else why not, as a code the page
 *  words — and what the command printed, for the log only. */
export function actionOutcome(
  ran: { code: number; stderr: string; timedOut?: boolean },
  readBack: boolean,
): null | { error: DaemonActionError; detail?: string } {
  if (readBack) return null;
  const printed = ran.stderr.trim().slice(0, 300);
  const detail = printed || `exit ${ran.code}`;
  if (ran.timedOut) return { error: "timeout", detail };
  if (ran.code === 0) return { error: "unverified", detail: "the command finished, but this computer's status didn't change" };
  return { error: "failed", detail };
}

// ── mafold-cli's own updates (activity center D5) ──

/** What `mafold update … --json` and `mafold rollback … --json` print
 *  (mafold-cli update.rs `command` / `rollback`), as far as the shell reads it. */
export interface CliSaid {
  ok?: boolean;
  code?: string;
  /** `update`: the release a check or an install found. */
  latest?: string | null;
  /** `rollback`: this binary's version, and the earlier one's. */
  from?: string;
  to?: string | null;
  /** It asked the supervisor here to restart onto the binary now on disk. */
  moving?: boolean;
  detail?: string;
}

/** clap's usage error: a mafold from before the flag. */
export const tooOldFor = (stderr: string): boolean => /unexpected argument|unrecognized subcommand|wasn't expected/i.test(stderr);

/** What the cli said — or, saying nothing the shell can read, why not. */
export function cliSaid(r: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): CliSaid | { error: CliUpdateError; detail: string } {
  const said = lastJson<CliSaid>(r.stdout);
  if (said && typeof said.code === "string") return said;
  const detail = r.stderr.trim().slice(0, 300) || `exit ${r.code}`;
  if (r.timedOut) return { error: "timeout", detail };
  if (tooOldFor(r.stderr)) return { error: "outdated", detail };
  return { error: "failed", detail };
}

/** A code the cli said that isn't done, as the page is told it. */
export function cliRefused(said: CliSaid): { error: CliUpdateError; detail?: string } {
  const known: Record<string, CliUpdateError> = { unsupported: "unsupported", no_backup: "no_backup", too_old: "too_old" };
  const error = (said.code && known[said.code]) || "failed";
  const detail = str(said.detail)?.slice(0, 300);
  return detail ? { error, detail } : { error };
}

/** What `mafold rollback --check --json` came to: a rollback to offer only
 *  when it would stick, to a version the earlier binary says it is. */
export function readRollbackCheck(r: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): CliRollbackCheck {
  const said = cliSaid(r);
  if ("error" in said) return { ok: false, ...said };
  if (said.code !== "possible") return { ok: false, ...cliRefused(said) };
  const from = str(said.from);
  const to = str(said.to);
  if (!from || !to) return { ok: false, error: "failed", detail: "the earlier version didn't say which it is" };
  return { ok: true, from, to };
}

/** Versions as the cli prints them, a leading `v` or not. */
export const sameVersion = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().replace(/^v/, "") === b.trim().replace(/^v/, "");

/** What an update action asked of this computer. `checkedSince`: a check
 *  that got an answer at or after then (epoch seconds). */
export type VersionAsked =
  | { installed: string }
  | { rolledBack: { from: string; to: string } }
  | { autoUpdate: boolean }
  | { channel: string }
  | { checkedSince: number };

/**
 * Does `s` read back as asked: the mafold on disk is the version installed;
 * rolled back, it is the earlier one AND the version left is skipped — a
 * rollback whose skip didn't reach the disk would update itself straight back
 * at the next check; the setting, or the channel, is the one set; a check
 * shows as answered since it was asked.
 */
export function versionReadsBack(asked: VersionAsked, s: DaemonStatus): boolean {
  if ("installed" in asked) return sameVersion(s.cli.version, asked.installed);
  if ("rolledBack" in asked) {
    return sameVersion(s.cli.version, asked.rolledBack.to) && sameVersion(s.update?.skipped?.version, asked.rolledBack.from);
  }
  if ("autoUpdate" in asked) return s.update?.autoUpdateSetting === asked.autoUpdate;
  if ("checkedSince" in asked) return (s.update?.checkedAt ?? -1) >= asked.checkedSince;
  return s.update?.channel === asked.channel;
}

/** Where the bots here are with `version`: the supervisor runs it (`on_it`),
 *  nothing runs them now (`none`), or neither yet (null). */
export function supervisorOn(version: string, s: DaemonStatus): "on_it" | "none" | null {
  if (s.supervisor !== "running") return "none";
  return sameVersion(s.cli.running, version) ? "on_it" : null;
}

export const isChannel = (v: unknown): v is "stable" | "dev" => v === "stable" || v === "dev";

// ── handing this computer to Mafold (activity center D6) ──

/** What `mafold up --adopt [--check] --json` prints (mafold-cli supervisor.rs
 *  `Adopt`), as far as the shell reads it. */
export interface CliAdopt {
  ok?: boolean;
  code?: string;
  detail?: string;
  reasons?: unknown;
  bots?: { name?: unknown; pid?: unknown; busy?: unknown }[];
  cut?: unknown;
  auto_update?: unknown;
}

/** The codes the cli answers with that the page is told as they are: refused
 *  before touching anything, or moved but not all the way. */
const ADOPT_ERRORS: readonly AdoptError[] = ["base_differs", "base_unknown", "no_service_manager", "inside_bot", "not_registered", "bots_not_back"];

/** What the cli said — or, saying nothing the shell can read, why not. */
export function adoptSaid(r: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): CliAdopt | { error: AdoptError; detail: string } {
  const said = lastJson<CliAdopt>(r.stdout);
  if (said && typeof said.code === "string") return said;
  const detail = r.stderr.trim().slice(0, 300) || `exit ${r.code}`;
  if (r.timedOut) return { error: "timeout", detail };
  if (tooOldFor(r.stderr)) return { error: "outdated", detail };
  return { error: "failed", detail };
}

/** A code the cli said that isn't done, as the page is told it. */
export function adoptRefused(said: CliAdopt): { error: AdoptError; detail?: string } {
  const error = ADOPT_ERRORS.find((e) => e === said.code) ?? "failed";
  const detail = str(said.detail)?.slice(0, 300);
  return detail ? { error, detail } : { error };
}

const ADOPT_STATES = ["adoptable", "managed", "not_set_up"] as const;

/** The names of the bots the cli listed, and of those it says are busy. */
const adoptBots = (said: CliAdopt): { bots: string[]; busy: string[] } => {
  const list = (Array.isArray(said.bots) ? said.bots : []).filter((b) => typeof b?.name === "string" && b.name);
  return { bots: list.map((b) => b.name as string), busy: list.filter((b) => b.busy === true).map((b) => b.name as string) };
};

/** What `mafold up --adopt --check --json` came to. A check that doesn't say
 *  whether it updates itself afterwards can't be put to the person: `failed`. */
export function readAdoptCheck(r: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): AdoptCheck {
  const said = adoptSaid(r);
  if ("error" in said) return { ok: false, ...said };
  const state = ADOPT_STATES.find((c) => c === said.code);
  if (said.ok !== true || !state) return { ok: false, ...adoptRefused(said) };
  if (typeof said.auto_update !== "boolean") return { ok: false, error: "failed", detail: "the check didn't say whether it updates itself afterwards" };
  return { ok: true, state, reasons: names(said.reasons) ?? [], ...adoptBots(said), autoUpdate: said.auto_update };
}

/** The same computer the person agreed to hand over: the same bots, the same
 *  update setting afterwards. Who is busy right now doesn't change what it does. */
export function sameAdopt(a: Extract<AdoptCheck, { ok: true }>, b: Extract<AdoptCheck, { ok: true }>): boolean {
  const key = (c: typeof a) => JSON.stringify([c.state, [...c.bots].sort(), c.autoUpdate]);
  return key(a) === key(b);
}

/** What `adopt` asked of this computer: `bots`, each running before as `before`
 *  (no pid: wasn't running), and updates as the dialog said. */
export interface AdoptAsked {
  bots: string[];
  before: Record<string, number | undefined>;
  autoUpdate: boolean;
}

/**
 * Does `s` read back as handed over: the supervisor here is the shell's and
 * runs; every bot the person agreed to runs again, as a process other than
 * the one before; and it updates itself as the dialog said — the old
 * `--no-auto-update` gone, this computer's setting in effect.
 */
export function adoptReadsBack(asked: AdoptAsked, s: DaemonStatus): boolean {
  if (s.supervisor !== "running") return false;
  if (s.update?.autoUpdate !== asked.autoUpdate) return false;
  return asked.bots.every((name) => {
    const b = s.bots.find((x) => x.name === name);
    if (!b?.running || b.pid === undefined) return false;
    return asked.before[name] === undefined || b.pid !== asked.before[name];
  });
}

/** The bots whose reply `adopt` cut off: still writing when the wait ran out. */
export const adoptCut = (said: CliAdopt): string[] => names(said.cut) ?? [];

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
