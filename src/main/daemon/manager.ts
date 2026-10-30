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
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type {
  AdoptCheck,
  AdoptError,
  AdoptResult,
  BotRestartResult,
  CliInstallResult,
  CliRollbackCheck,
  CliUpdateResult,
  DaemonActionError,
  DaemonDisableResult,
  DaemonEnableResult,
  DaemonStatus,
  DiagnoseResult,
  LogError,
  LogFrame,
  LogTail,
  RuntimeLoginError,
  RuntimeLoginResult,
  RuntimeLoginStart,
} from "../../shared/desktopHost.generated";
import { log } from "../log";
import { canonicalExe, ensureInstalled, runCli, spawnCli, type CliPaths, type RunResult } from "./cli";
import {
  cliLogError,
  diagnoseName,
  FRAME_EVERY_MS,
  lineCount,
  LogBuffer,
  MAX_LOG_LINES,
  MAX_RAW_LINE,
  MAX_TAIL_BYTES,
  mayReadLog,
  readLogLine,
} from "./logs";
import {
  actionOutcome,
  adoptCut,
  adoptReadsBack,
  adoptRefused,
  adoptSaid,
  cliRefused,
  cliSaid,
  isChannel,
  isOwnBot,
  isSignInUrl,
  lastJson,
  readAdoptCheck,
  readBack,
  readRestart,
  readRollbackCheck,
  readRuntimeLoginLine,
  readsBack,
  runtimeReadsBack,
  sameAccount,
  sameAdopt,
  sameVersion,
  SIGN_IN_RUNTIMES,
  supervisorOn,
  toDaemonStatus,
  versionReadsBack,
  type Asked,
  type CliStatus,
  type RuntimeLoginEvent,
  type VersionAsked,
} from "./model";

/** What the shell asks the person in a native dialog the page cannot answer:
 *  starting or stopping the bots here, going back to an earlier mafold, and
 *  handing bots another mafold runs to this one. */
export type Confirm =
  | { kind: "enable" | "disable"; handle: string; everyone: boolean }
  | { kind: "rollback"; version: string; skipped: string }
  | { kind: "adopt"; bots: string[]; autoUpdate: boolean };

/** A {@link Confirm} dialog's words, from the build's own strings (`frozen`):
 *  the page — and any card running in it — must not choose what it says. */
export function confirmText(ask: Confirm, frozen: (key: string, vars: Record<string, string>) => string): { message: string; detail: string; ok: string } {
  const vars: Record<string, string> =
    ask.kind === "rollback"
      ? { version: ask.version, skipped: ask.skipped }
      : ask.kind === "adopt"
        ? { bots: ask.bots.join(", ") }
        : { handle: ask.handle };
  const f = (k: string) => frozen(k, vars);
  if (ask.kind === "enable") return { message: f("desktop.daemon.enable.title"), detail: f("desktop.daemon.enable.detail"), ok: f("desktop.daemon.enable.ok") };
  if (ask.kind === "disable") {
    return {
      message: f("desktop.daemon.disable.title"),
      detail: f(ask.everyone ? "desktop.daemon.disable.detailAll" : "desktop.daemon.disable.detailOne"),
      ok: f("desktop.daemon.disable.ok"),
    };
  }
  if (ask.kind === "adopt") {
    // How updates will be afterwards — on only where this computer's setting
    // has them on (the old `--no-auto-update` doesn't come along) — said as
    // the outcome, true whatever they are now. Then the bots it restarts, as
    // a paragraph of its own: none, none named.
    const updates = f(ask.autoUpdate ? "desktop.adopt.detail" : "desktop.adopt.detailUpdatesOff");
    return {
      message: f("desktop.adopt.title"),
      detail: ask.bots.length ? `${updates}\n\n${f("desktop.adopt.bots")}` : updates,
      ok: f("desktop.adopt.ok"),
    };
  }
  return { message: f("desktop.rollback.title"), detail: f("desktop.rollback.detail"), ok: f("desktop.rollback.ok") };
}

export interface DaemonDeps {
  paths: CliPaths;
  env(): Promise<NodeJS.ProcessEnv>;
  /** Ask the person in a native dialog the page cannot answer. */
  confirm(ask: Confirm): Promise<boolean>;
  /** The page wants to hear about it. */
  emit(status: DaemonStatus): void;
  /** Open a sign-in page in the system browser; false = it couldn't be. */
  openExternal(url: string): boolean;
  /** A frame of the followed log, for the page (the `logs` event). */
  emitLogs(frame: { id: number } & LogFrame): void;
  /** Where to write the diagnostics file: the system's save dialog, `name`
   *  suggested. Null: the person closed it. */
  saveAs(name: string): Promise<string | null>;
}

const UNLOCK_EVERY_MS = 10_000;
const UNLOCK_FOR_MS = 10 * 60_000;
const LOGIN_CODE_WAIT_MS = 60_000;
/** `mafold restart` waits up to 20 s for the supervisor to take the request
 *  and 30 s for its answer, then looks once more after 1.5 s. */
const RESTART_MS = 60_000;
/** How long a start or stop gets to read back as asked, looked at once a
 *  second: `up` waits up to 15 s for the supervisor itself, `down` 10 s for
 *  what it stops. */
const READ_BACK_MS = 20_000;
const READ_BACK_EVERY_MS = 1_000;
/** A runtime sign-in: the link (the cli waits 60 s for it), the whole of it
 *  (the cli waits 5 min for the code), and the read-back after — the
 *  supervisor probes the runtime again on its next round, every 30 s. */
const RUNTIME_LINK_WAIT_MS = 75_000;
const RUNTIME_LOGIN_MS = 7 * 60_000;
const RUNTIME_READ_BACK_MS = 90_000;
const RUNTIME_READ_BACK_EVERY_MS = 3_000;
/** Longer than any Authentication Code; a page sending more is refused. */
const MAX_CODE_LENGTH = 1024;
/** `mafold logs` reads the end of one file; `mafold diagnose` also asks every
 *  runtime how its login is doing, as `status` does. */
const LOGS_MS = 15_000;
const DIAGNOSE_MS = 60_000;
/** mafold-cli's own updates (activity center D5): a check asks the release
 *  feed; an install downloads (about 2 minutes from GitHub, measured for C8);
 *  a rollback copies a file, then waits up to 20 s for the supervisor to take
 *  its restart request and 20 s more for it to come back. */
const CHECK_MS = 60_000;
const INSTALL_MS = 10 * 60_000;
const ROLLBACK_MS = 2 * 60_000;
const SETTING_MS = 30_000;
/** The supervisor restarts onto a new binary once the replies it is writing
 *  are written — up to 5 minutes; looked at every 3 s. */
const RESTART_ONTO_MS = 6 * 60_000;
const RESTART_ONTO_EVERY_MS = 3_000;
/** Handing this computer to Mafold (activity center D6): a check reads the
 *  service and the bots. The move waits up to 5 minutes for the replies being
 *  written, 10 s for each stop, 15 s for the new supervisor and 30 s for the
 *  bots to be back — the cli's own deadlines all come first, so it is never
 *  stopped halfway through a move. */
const ADOPT_CHECK_MS = 30_000;
const ADOPT_MS = 10 * 60_000;

/** Why, as a code the page words — and what was printed, for the log only. */
type Failed = { error: DaemonActionError; detail?: string };

/** Now, on the clock `status --json` writes its times in (epoch seconds). */
const nowSecs = (): number => Math.floor(Date.now() / 1000);

const failed = (error: DaemonActionError, e?: unknown): Failed => {
  const detail = e === undefined ? undefined : e instanceof Error ? e.message : String(e);
  return detail ? { error, detail } : { error };
};

/** Handing the computer over threw: `failed`, what it threw for the log. */
const adoptFailed = (e: unknown): { ok: false; error: AdoptError; detail?: string } => ({ ok: false, ...(failed("failed", e) as { error: "failed"; detail?: string }) });

export class DaemonManager {
  private task: DaemonStatus["task"] = null;
  private lastSent = "";
  /** Who `enable` is starting the bots for — what the start reads back. */
  private enabling = "";
  private login: ChildProcess | null = null;
  private busy = false;
  /** Bots being restarted: a second ask while one is under way — the card
   *  opened again, another window — gets that restart's outcome. */
  private restarting = new Map<string, Promise<BotRestartResult>>();
  /** The runtime sign-in under way (`runtimeLogin`), one at a time. */
  private signIn: SignIn | null = null;
  /** The followed log (`followLogs`), one at a time — and the one being
   *  started, until its cli runs. */
  private follow: Follow | null = null;
  private starting: { id: number; stopped?: LogError } | null = null;
  /** A diagnostics file being written: asked again meanwhile, the same outcome. */
  private diagnosing: Promise<DiagnoseResult> | null = null;
  /** An install or a rollback waiting for the supervisor to restart onto it. */
  private restartingOnto = false;

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

  /** A step stopped: said in the log with what was printed, and to the page
   *  as its code. */
  private stopped(step: NonNullable<DaemonStatus["task"]>["step"], f: Failed): Failed {
    log(`${step} failed: ${f.error}${f.detail ? ` (${f.detail})` : ""}`);
    this.setTask({ step, ...f });
    return f;
  }

  /** Wait for this computer's status to read back as `asked`, up to
   *  {@link READ_BACK_MS}. */
  private settled(asked: Asked): Promise<boolean> {
    return this.until((s) => readsBack(asked, s), READ_BACK_MS, READ_BACK_EVERY_MS);
  }

  /** Wait for this computer's status to satisfy `check`, for up to `ms`,
   *  looked at every `every` ms — `tell`ing the page what each look saw. */
  private async until(check: (s: DaemonStatus) => boolean, ms: number, every: number, tell = false): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if (check(await (tell ? this.refresh() : this.status()))) return true;
      if (Date.now() >= until) return false;
      await new Promise((res) => setTimeout(res, every));
    }
  }

  async enable(username: string): Promise<DaemonEnableResult> {
    if (this.busy) return { error: "busy" };
    // Claimed before the first await: an update action asked while the dialog
    // is up is told `busy` instead of running alongside (activity center D5).
    this.busy = true;
    let no: DaemonEnableResult | null;
    try {
      const before = await this.status();
      no =
        before.supervisor === "foreign"
          ? { error: "foreign" }
          : (await this.deps.confirm({ kind: "enable", handle: username, everyone: false }))
            ? null
            : { error: "cancelled" };
    } catch (e) {
      this.busy = false;
      throw e;
    }
    if (no) {
      this.busy = false;
      return no;
    }
    this.enabling = username;
    try {
      const env = await this.deps.env();
      this.setTask({ step: "install" });
      try {
        await ensureInstalled(this.deps.paths, env);
      } catch (e) {
        this.busy = false;
        return this.stopped("install", failed("cli_missing", e));
      }
      let now = await this.status();
      // An existing mafold older than this shell's needs: bring it up to date
      // the cli's own way (checksummed, with a rollback copy) before reading it.
      if (now.cli.outdated) {
        const u = await runCli(this.deps.paths, env, ["update"], 5 * 60_000);
        now = await this.status();
        if (now.cli.outdated) {
          this.busy = false;
          return this.stopped("install", failed(u.timedOut ? "timeout" : "unsupported", `mafold update: ${u.stderr.trim() || `exit ${u.code}`}`));
        }
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
      return await this.startLogin(env, "login", () => void this.finish());
    } catch (e) {
      this.busy = false;
      return this.stopped("install", failed("failed", e));
    }
  }

  /**
   * Sign `username` in again: someone signed in here whose login Mafold
   * refused (`mafold_signed_out` — it expired, or was revoked). The same
   * device-code sign-in as `enable`'s, without `up`: the supervisor serving
   * the others takes the new login on its next round. It counts once the
   * status shows them signed in and no longer refused (activity center D3).
   */
  async relogin(username: string): Promise<DaemonEnableResult> {
    if (this.busy) return { error: "busy" };
    // Claimed before the first await, as `enable` does.
    this.busy = true;
    let no: DaemonEnableResult | null = null;
    try {
      const s = await this.status();
      if (!s.cli.installed) no = { error: "cli_missing" };
      // Not signed in here at all: that is a first sign-in, `enable`.
      else if (!s.accounts.some((a) => sameAccount(a, username))) no = { error: "failed", detail: `${username} isn't signed in on this computer` };
    } catch (e) {
      this.busy = false;
      throw e;
    }
    if (no) {
      this.busy = false;
      return no;
    }
    try {
      const env = await this.deps.env();
      this.setTask({ step: "relogin" });
      return await this.startLogin(env, "relogin", (as) => void this.reloggedIn(username, as));
    } catch (e) {
      this.busy = false;
      return this.stopped("relogin", failed("failed", e));
    }
  }

  /** Approved as `as`: read back that it is `username` here again. */
  private async reloggedIn(username: string, as: string): Promise<void> {
    try {
      // Someone else approved it: a sign-in for them, not this one again.
      if (as && !sameAccount(as, username)) {
        this.busy = false;
        this.stopped("relogin", failed("unverified", `approved as ${as}, not ${username}`));
        return;
      }
      const back = await this.settled({ relogin: username });
      this.busy = false;
      if (back) this.setTask(null);
      else this.stopped("relogin", failed("unverified", "signed in, but this computer still says the login is refused"));
    } catch (e) {
      this.busy = false;
      this.stopped("relogin", failed("failed", e));
    }
  }

  /** `login --device-json --no-up`: resolve with the code as soon as it is
   *  printed; the rest of the sign-in carries on in the background, and
   *  `approved` hears who approved it. */
  private startLogin(env: NodeJS.ProcessEnv, step: "login" | "relogin", approved: (as: string) => void): Promise<DaemonEnableResult> {
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
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        settle({ error: "timeout", detail: "the sign-in did not start" });
        child.kill();
      }, LOGIN_CODE_WAIT_MS);
      let ok = false;
      lines(child, (line) => {
        if (!line.startsWith("{")) return;
        let ev: { event?: string; user_code?: string; username?: unknown } = {};
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.event === "code" && ev.user_code) {
          clearTimeout(timer);
          settle({ userCode: ev.user_code });
        } else if (ev.event === "approved") {
          ok = true;
          approved(typeof ev.username === "string" ? ev.username : "");
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        this.login = null;
        if (!settled) settle({ error: "failed", detail: `the sign-in ended early (${code})` });
        // Expired, refused or killed before anyone approved: nothing more is
        // coming, so free the manager and say what happened.
        if (!ok) {
          this.busy = false;
          this.stopped(step, late ? failed("timeout", "the sign-in did not start") : failed("failed", code === 0 ? "the sign-in ended" : "the sign-in code expired"));
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
      if (before.supervisor === "foreign") {
        this.busy = false;
        this.stopped("start", failed("foreign"));
        return;
      }
      this.setTask({ step: "start" });
      const up = await runCli(this.deps.paths, env, ["up"], 120_000);
      // Running, with this person signed in — read back, whatever `up` exited with.
      const outcome = actionOutcome(up, await this.settled({ start: this.enabling }));
      this.busy = false;
      if (outcome) this.stopped("start", outcome);
      else this.setTask(null);
    } catch (e) {
      this.busy = false;
      this.stopped("start", failed("failed", e));
    }
  }

  async disable(username: string): Promise<DaemonDisableResult> {
    if (this.busy) return { ok: false, error: "busy" };
    // Claimed before the first await, as `enable` does.
    this.busy = true;
    let everyone = false;
    let no: DaemonDisableResult | null = null;
    try {
      const s = await this.status();
      if (s.supervisor === "foreign") no = { ok: false, error: "foreign" };
      else if (!s.cli.installed) no = { ok: true };
      else {
        // The supervisor serves everyone signed in here: with one account (or
        // only this one) stopping it is the request; with others, sign just
        // this one out.
        everyone = s.accounts.every((a) => sameAccount(a, username));
        if (!(await this.deps.confirm({ kind: "disable", handle: username, everyone }))) no = { ok: false, error: "cancelled" };
      }
    } catch (e) {
      this.busy = false;
      throw e;
    }
    if (no) {
      this.busy = false;
      return no;
    }
    try {
      const env = await this.deps.env();
      this.setTask({ step: "stop" });
      const r = everyone
        ? await runCli(this.deps.paths, env, ["down"], 120_000)
        : await runCli(this.deps.paths, env, ["account", "rm", username], 60_000);
      // Stopped — or, stopping one of several people, this one signed out.
      const outcome = actionOutcome(r, await this.settled({ stop: username, everyone }));
      this.busy = false;
      if (!outcome) {
        this.setTask(null);
        return { ok: true };
      }
      return { ok: false, ...this.stopped("stop", outcome) };
    } catch (e) {
      this.busy = false;
      return { ok: false, ...this.stopped("stop", failed("failed", e)) };
    }
  }

  /**
   * Restart one bot on this computer: `mafold restart <name> --json` asks the
   * supervisor, which stops the bot and starts it again (mafold-cli C7). It
   * counts once the cli has read the new process back AND this shell's own
   * `status --json` shows the bot running as that process.
   *
   * Not barred by `foreign`: that guards the service's registration, which
   * `up` would take over — a restart asks whichever supervisor runs here and
   * leaves the service as it is.
   */
  restart(name: string, username?: string): Promise<BotRestartResult> {
    // The page said who it is signed in as: only that person's bot.
    if (username !== undefined && !isOwnBot(name, username)) return Promise.resolve({ ok: false, error: "not_yours" });
    const under = this.restarting.get(name);
    if (under) return under;
    const p = this.restartOnce(name).finally(() => this.restarting.delete(name));
    this.restarting.set(name, p);
    return p;
  }

  private async restartOnce(name: string): Promise<BotRestartResult> {
    const before = await this.status();
    if (!before.cli.installed) return { ok: false, error: "no_supervisor" };
    if (!before.bots.some((b) => b.name === name)) return { ok: false, error: "unknown_bot" };
    const env = await this.deps.env();
    const r = await runCli(this.deps.paths, env, ["restart", name, "--json"], RESTART_MS);
    return readBack(readRestart(r), name, await this.refresh());
  }

  /**
   * Sign this computer's `runtime` in (activity center D3): `mafold runtime
   * login <runtime> --json` — mafold-cli C11, the very sign-in a bot's
   * `/login` runs. Resolves once the sign-in page is out, opened in the system
   * browser; `runtimeLoginCode` hands back the code the person copies from it.
   * Asked again while one waits: the person started over, and it replaces
   * that one.
   */
  async runtimeLogin(runtime: string): Promise<RuntimeLoginStart> {
    if (!SIGN_IN_RUNTIMES.includes(runtime)) return { error: "unsupported" };
    const s = await this.status();
    if (!s.cli.installed) return { error: "cli_missing" };
    if (!s.harnesses.some((h) => h.id === runtime && h.available)) return { error: "runtime_missing" };
    if (this.signIn) this.stopSignIn(this.signIn);
    const env = await this.deps.env();
    const child = spawnCli(this.deps.paths, env, ["runtime", "login", runtime, "--json"], { stdin: true });
    let answer!: (r: RuntimeLoginStart) => void;
    const start = new Promise<RuntimeLoginStart>((res) => (answer = res));
    const sign: SignIn = { child, linked: false, coded: false, cancelled: false, finished: Promise.resolve({ ok: false, error: "failed" }) };
    let answered = false;
    const started = (r: RuntimeLoginStart) => {
      if (answered) return;
      answered = true;
      answer(r);
    };
    // The cli gives up on the link after 60 s and on the code after 5 min;
    // these only catch a cli that says nothing at all.
    const noLink = setTimeout(() => {
      started({ error: "no_link", detail: "no sign-in link in time" });
      child.kill();
    }, RUNTIME_LINK_WAIT_MS);
    const tooLong = setTimeout(() => child.kill(), RUNTIME_LOGIN_MS);
    const said: { last: RuntimeLoginEvent | null } = { last: null };
    let stderr = "";
    lines(child, (line) => {
      const ev = readRuntimeLoginLine(line);
      if (ev?.event === "link") {
        clearTimeout(noLink);
        sign.linked = true;
        // Opened only on Anthropic's own hosts; anything else is shown, never opened.
        const ours = isSignInUrl(ev.url);
        if (!ours) log("runtime login: not opening a sign-in page off Anthropic's hosts");
        started({ url: ev.url, opened: ours && this.deps.openExternal(ev.url) });
      } else if (ev?.event === "done" || ev?.event === "failed") said.last = ev;
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
    });
    const exited = new Promise<number | null>((res) => {
      child.on("exit", (code) => res(code));
      child.on("error", () => res(null));
    });
    sign.finished = (async (): Promise<RuntimeLoginResult> => {
      const code = await exited;
      clearTimeout(noLink);
      clearTimeout(tooLong);
      if (this.signIn === sign) this.signIn = null;
      const last = said.last;
      if (last?.event !== "done") {
        const why: { error: RuntimeLoginError; detail?: string } =
          last?.event === "failed"
            ? last.detail
              ? { error: last.error, detail: last.detail }
              : { error: last.error }
            : sign.cancelled
              ? { error: "cancelled" }
              : /unrecognized subcommand|unexpected argument/i.test(stderr)
                ? { error: "outdated" }
                : { error: "failed", detail: stderr.trim().slice(0, 300) || `exit ${code}` };
        if (why.detail) log(`runtime login failed: ${why.error} (${why.detail})`);
        started(why);
        return { ok: false, ...why };
      }
      // Signed in, as the cli read it back — now as this computer's status
      // reads it: the supervisor probes the runtime again on its next round.
      const back = await this.until((st) => runtimeReadsBack(runtime, st), RUNTIME_READ_BACK_MS, RUNTIME_READ_BACK_EVERY_MS);
      void this.refresh();
      if (!back) return { ok: false, error: "unverified", detail: "signed in, but this computer's status still says it needs signing in" };
      return last.email ? { ok: true, email: last.email } : { ok: true };
    })();
    this.signIn = sign;
    return start;
  }

  /** The Authentication Code for the sign-in waiting for one. A second code
   *  while the first is being checked gets the first one's outcome. */
  runtimeLoginCode(code: unknown): Promise<RuntimeLoginResult> {
    const sign = this.signIn;
    if (!sign?.linked) return Promise.resolve({ ok: false, error: "not_started" });
    const c = typeof code === "string" ? code.trim() : "";
    if (!c || c.length > MAX_CODE_LENGTH || /[\r\n]/.test(c)) return Promise.resolve({ ok: false, error: "refused" });
    if (!sign.coded) {
      sign.coded = true;
      sign.child.stdin?.end(`${c}\n`);
    }
    return sign.finished;
  }

  /** Stop the sign-in waiting for its code, if there is one. */
  async runtimeLoginCancel(): Promise<void> {
    if (this.signIn) this.stopSignIn(this.signIn);
  }

  /** Once the link is out the cli reads the code from stdin, and closing it is
   *  how it hears "nobody's answering" — it then stops `claude` itself. Before
   *  that, or if it doesn't go, it is killed. */
  private stopSignIn(sign: SignIn): void {
    sign.cancelled = true;
    if (this.signIn === sign) this.signIn = null;
    if (sign.linked && !sign.coded) {
      sign.child.stdin?.end();
      setTimeout(() => sign.child.kill(), 5_000).unref?.();
    } else {
      sign.child.kill();
    }
  }

  /**
   * The last `lines` of a log (activity center D4): `bot`'s — one of the
   * person's — or, `null`, the supervisor's. `mafold logs [bot] -n <lines>
   * --json` finds it, as it does in a terminal.
   */
  async logs(username: string, bot: string | null, lines: unknown): Promise<LogTail> {
    const why = await this.mayRead(username, bot);
    if (why) return { ok: false, error: why };
    const env = await this.deps.env();
    // Read as it comes, never more than `MAX_TAIL_BYTES` held: the cli cuts no
    // line, and 500 long ones run to megabytes.
    const child = spawnCli(this.deps.paths, env, logsArgs(bot, lineCount(lines), false));
    const buf = new LogBuffer(MAX_TAIL_BYTES, MAX_LOG_LINES);
    let opened = false;
    readLog(child, buf, () => (opened = true));
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, LOGS_MS);
    const code = await new Promise<number | null>((res) => {
      child.on("close", res);
      child.on("error", () => res(null));
    });
    clearTimeout(timer);
    // `open` comes first from every mafold that has `logs --json`.
    if (code !== 0 || !opened) return { ok: false, ...cliFailed("logs", { code, stderr, timedOut }) };
    const got = buf.take();
    return { ok: true, lines: got?.lines ?? [], ...(got?.skipped ? { skipped: got.skipped } : {}) };
  }

  /** Someone else's bot is turned away before the cli is asked anything. */
  private async mayRead(username: string, bot: string | null): Promise<LogError | null> {
    if (bot !== null && !isOwnBot(bot, username)) return "not_yours";
    return mayReadLog(username, bot, await this.status());
  }

  /**
   * Follow a log: its last `lines`, then whatever gets written, to the page as
   * `logs` frames (`emitLogs`) tagged with `id`, the page's own name for this
   * follow — `mafold logs [bot] -n <lines> -f --json`, limited on the way
   * (logs.ts `LogBuffer`). One at a time: this ends any other (`replaced`).
   * Resolves once the cli runs; how it ends — a log that isn't there, a mafold
   * without `logs` — comes as the last frame's `end`.
   */
  async followLogs(id: number, username: string, bot: string | null, lines: unknown): Promise<{ ok: true } | { ok: false; error: LogError }> {
    this.stopFollow(null, "replaced");
    const start: { id: number; stopped?: LogError } = { id };
    this.starting = start;
    const why = await this.mayRead(username, bot);
    const env = why ? null : await this.deps.env();
    // Stopped while it was being looked into: the window closed, a newer one.
    if (start.stopped) return { ok: false, error: start.stopped };
    this.starting = null;
    if (why || !env) return { ok: false, error: why ?? "failed" };
    const child = spawnCli(this.deps.paths, env, logsArgs(bot, lineCount(lines), true));
    this.follow = new Follow(id, child, (f) => this.deps.emitLogs(f), (f) => {
      if (this.follow === f) this.follow = null;
    });
    return { ok: true };
  }

  /** Stop following: the follow the page named `id`, or — `null` — whichever
   *  runs (the window closed, the page went). Its last frame says `why`. */
  stopFollow(id: number | null, why: LogError): void {
    if (this.starting && (id === null || this.starting.id === id)) {
      this.starting.stopped = why;
      this.starting = null;
    }
    const f = this.follow;
    if (f && (id === null || f.id === id)) {
      this.follow = null;
      f.stop(why);
    }
  }

  /**
   * Write a diagnostics file where the person picks in the system's save
   * dialog: `mafold diagnose --out <there> --json` (mafold-cli C6 — masked,
   * no conversations). It counts once the file is there, as big as the cli
   * said; the page hears only its name and size, never what is in it.
   */
  diagnose(): Promise<DiagnoseResult> {
    this.diagnosing ??= this.diagnoseOnce().finally(() => (this.diagnosing = null));
    return this.diagnosing;
  }

  private async diagnoseOnce(): Promise<DiagnoseResult> {
    if (!(await this.status()).cli.installed) return { ok: false, error: "cli_missing" };
    const where = await this.deps.saveAs(diagnoseName(Date.now()));
    if (!where) return { ok: false, error: "cancelled" };
    const env = await this.deps.env();
    const r = await runCli(this.deps.paths, env, ["diagnose", "--out", where, "--json"], DIAGNOSE_MS);
    const said = r.code === 0 ? lastJson<{ bytes?: unknown; masked?: unknown }>(r.stdout) : null;
    if (typeof said?.bytes !== "number") return { ok: false, ...cliFailed("diagnose", r) };
    let size = -1;
    try {
      size = statSync(where).size;
    } catch {
      /* not there */
    }
    if (size !== said.bytes) {
      log(`diagnose: the cli said ${said.bytes} bytes, the file has ${size}`);
      return { ok: false, error: "unverified" };
    }
    return { ok: true, name: basename(where), bytes: said.bytes, masked: typeof said.masked === "number" ? said.masked : 0 };
  }

  // ── mafold-cli's own updates (activity center D5) ──
  //
  // mafold-cli C8/C9 do the work — `update --check`, `update`, `update
  // --auto-update`, `update --channel`, `rollback --check`, `rollback` — and
  // each counts once this computer's status reads it back, never on what the
  // cli printed. None of it touches a supervisor that isn't the shell's
  // (`foreign`): the cli asks whichever supervisor runs here to restart onto
  // the binary it just changed, and the settings it writes are this computer's.

  /** What the release feed offers now; installs nothing. Counts once the
   *  status shows a check answered since it was asked. */
  checkUpdate(): Promise<CliUpdateResult> {
    const since = nowSecs() - 1;
    return this.setting(["update", "--check", "--json"], { checkedSince: since }, CHECK_MS, since);
  }

  /** Turn this computer's automatic updates on or off: a setting the
   *  supervisor reads on every pass, nothing restarted — and no longer the
   *  service's `--no-auto-update`, which made it someone else's (C8). */
  setAutoUpdate(on: boolean): Promise<CliUpdateResult> {
    if (typeof on !== "boolean") return Promise.resolve({ ok: false, error: "refused" });
    return this.setting(["update", "--auto-update", on ? "on" : "off", "--json"], { autoUpdate: on }, SETTING_MS);
  }

  /** Follow `channel` from now on, and check what it offers; installs nothing. */
  setChannel(channel: unknown): Promise<CliUpdateResult> {
    if (!isChannel(channel)) return Promise.resolve({ ok: false, error: "refused" });
    return this.setting(["update", "--channel", channel, "--check", "--json"], { channel }, CHECK_MS, nowSecs() - 1);
  }

  /**
   * Take the shell for an update action — taken at once, so two asks at the
   * same moment can't both start — once the mafold here may be asked: it is
   * there, and the supervisor here is the shell's (`foreign`: the cli would
   * restart another install's). `outdated` only where the plain `update`
   * can't help. An install or a rollback (`moves`) also waits for the last
   * one's supervisor to have restarted onto it (`onto`). Handing the computer
   * over (`foreignOk`) is the one thing asked of a supervisor that isn't the
   * shell's. Given back by the caller (`busy = false`), or here when no.
   */
  private async take(
    opts: { outdatedOk?: boolean; moves?: boolean; foreignOk?: boolean } = {},
  ): Promise<{ ok: true; s: DaemonStatus } | { ok: false; error: "busy" | "cli_missing" | "outdated" | "foreign" | "failed"; detail?: string }> {
    if (this.busy || (opts.moves && this.restartingOnto)) return { ok: false, error: "busy" };
    this.busy = true;
    try {
      const s = await this.status();
      const why = !s.cli.installed
        ? "cli_missing"
        : s.cli.outdated && !opts.outdatedOk
          ? "outdated"
          : s.supervisor === "foreign" && !opts.foreignOk
            ? "foreign"
            : null;
      if (!why) return { ok: true, s };
      this.busy = false;
      return { ok: false, error: why };
    } catch (e) {
      this.busy = false;
      return { ok: false, error: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A check or a setting: the cli asked, then this computer's update state
   *  read back — as `asked`, whatever the cli exited with (a channel switched
   *  whose check then failed is switched). `checked`: the command also checks,
   *  asked at that time — what it offered is passed on once that reads back. */
  private async setting(args: string[], asked: VersionAsked, ms: number, checked?: number): Promise<CliUpdateResult> {
    const ready = await this.take();
    if (!ready.ok) return ready;
    try {
      const env = await this.deps.env();
      const said = cliSaid(await runCli(this.deps.paths, env, args, ms));
      const after = await this.refresh();
      if (!versionReadsBack(asked, after)) {
        if ("error" in said) return { ok: false, ...said };
        if (said.ok === false) return { ok: false, ...cliRefused(said) };
        return { ok: false, error: "unverified", detail: "the cli said it did, but this computer's status doesn't show it" };
      }
      if (!after.update) return { ok: false, error: "outdated" };
      const offered =
        checked !== undefined && !("error" in said) && (said.code === "available" || said.code === "current") && versionReadsBack({ checkedSince: checked }, after);
      const latest = offered && !("error" in said) && typeof said.latest === "string" && said.latest ? said.latest : undefined;
      return latest ? { ok: true, update: after.update, latest } : { ok: true, update: after.update };
    } catch (e) {
      return { ok: false, ...failed("failed", e) };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Install the newest release: `mafold update --json` (checksummed, the old
   * binary kept for a rollback). It counts once the new version reads back on
   * disk — and, where the cli asked the supervisor here to restart onto it,
   * once the supervisor runs it (`onto`). A mafold from before `update
   * --json` gets the plain `update`, read back by its version changing.
   */
  async updateCli(): Promise<CliInstallResult> {
    const ready = await this.take({ outdatedOk: true, moves: true });
    if (!ready.ok) return ready;
    const before = ready.s;
    let done: { version: string; updated: boolean; moving: boolean };
    try {
      // No release is built for this computer: a cli from before `--json`
      // would only say so in words, and exit 0.
      if (before.update?.supported === false) return { ok: false, error: "unsupported" };
      const env = await this.deps.env();
      const said = cliSaid(await runCli(this.deps.paths, env, ["update", "--json"], INSTALL_MS));
      if ("error" in said && said.error === "outdated") {
        const r = await runCli(this.deps.paths, env, ["update"], INSTALL_MS);
        const after = await this.status();
        if (after.cli.outdated || !after.cli.version) {
          return { ok: false, error: r.timedOut ? "timeout" : "failed", detail: r.stderr.trim().slice(0, 300) || `exit ${r.code}` };
        }
        if (r.code !== 0 && after.cli.version === before.cli.version) {
          return { ok: false, error: r.timedOut ? "timeout" : "failed", detail: r.stderr.trim().slice(0, 300) || `exit ${r.code}` };
        }
        // Whether it asked the supervisor to move, it doesn't say: not waited for.
        done = { version: after.cli.version, updated: after.cli.version !== before.cli.version, moving: false };
      } else if ("error" in said) {
        return { ok: false, ...said };
      } else if (said.code === "updated" && typeof said.latest === "string" && said.latest) {
        if (!versionReadsBack({ installed: said.latest }, await this.status())) {
          return { ok: false, error: "unverified", detail: `the cli said it installed v${said.latest}, but this computer's mafold isn't that version` };
        }
        done = { version: said.latest, updated: true, moving: said.moving === true };
      } else if (said.code === "current") {
        const now = await this.status();
        done = { version: now.cli.version ?? before.cli.version ?? "", updated: false, moving: false };
      } else {
        return { ok: false, ...cliRefused(said) };
      }
    } catch (e) {
      return { ok: false, ...failed("failed", e) };
    } finally {
      this.busy = false;
      void this.refresh();
    }
    return this.onto(done.version, done.updated, done.moving);
  }

  /** Is there an earlier mafold here to go back to that would stay
   *  (`mafold rollback --check --json`, C9)? */
  async rollbackCheck(): Promise<CliRollbackCheck> {
    const ready = await this.take({ moves: true });
    if (!ready.ok) return ready;
    try {
      const env = await this.deps.env();
      return readRollbackCheck(await runCli(this.deps.paths, env, ["rollback", "--check", "--json"], SETTING_MS));
    } catch (e) {
      return { ok: false, ...failed("failed", e) };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Go back to the earlier mafold: asked natively first (the version, and the
   * one left skipped — words the page can't choose), then `mafold rollback
   * --json`. Never `--force`: an earlier binary that can't keep the skip is
   * offered no rollback at all (`too_old`). Only the versions the dialog
   * named: asked again once taken, and `changed` if an update landed while the
   * dialog was up. It counts once the status reads back the earlier version on
   * disk AND the one left as skipped — a skip that didn't reach the disk would
   * undo the rollback at the next check — then, like an install, once the
   * supervisor runs it (`onto`).
   */
  async rollback(): Promise<CliInstallResult> {
    const check = await this.rollbackCheck();
    if (!check.ok) return check;
    if (!(await this.deps.confirm({ kind: "rollback", version: check.to, skipped: check.from }))) return { ok: false, error: "cancelled" };
    // Taken again: something may have started, or changed here, while the dialog was up.
    const ready = await this.take({ moves: true });
    if (!ready.ok) return ready;
    const { from, to } = check;
    let done: { version: string; moving: boolean };
    try {
      const env = await this.deps.env();
      const again = readRollbackCheck(await runCli(this.deps.paths, env, ["rollback", "--check", "--json"], SETTING_MS));
      if (!again.ok) return again;
      if (!sameVersion(again.from, from) || !sameVersion(again.to, to)) {
        return { ok: false, error: "changed", detail: `agreed to v${to} with v${from} skipped; this computer now has v${again.from}, and v${again.to} to go back to` };
      }
      const said = cliSaid(await runCli(this.deps.paths, env, ["rollback", "--json"], ROLLBACK_MS));
      if ("error" in said) return { ok: false, ...said };
      if (said.code !== "rolled_back") return { ok: false, ...cliRefused(said) };
      if (!versionReadsBack({ rolledBack: { from, to } }, await this.status())) {
        return { ok: false, error: "unverified", detail: `the cli said it rolled back, but this computer's status doesn't show v${to} with v${from} skipped` };
      }
      done = { version: to, moving: said.moving === true };
    } catch (e) {
      return { ok: false, ...failed("failed", e) };
    } finally {
      this.busy = false;
      void this.refresh();
    }
    return this.onto(done.version, true, done.moving);
  }

  /**
   * `version` is on disk: where the supervisor here is with it. Asked to
   * restart onto it (`moving`), it does once the replies it is writing are
   * written — waited for, the page hearing each look, up to 6 minutes, and no
   * other install or rollback started meanwhile. Not moved onto it (it takes
   * no restart requests, didn't take this one, or nobody asked): `later`.
   */
  private async onto(version: string, updated: boolean, moving: boolean): Promise<CliInstallResult> {
    const now = await this.refresh();
    const there = supervisorOn(version, now);
    if (there) return { ok: true, version, updated, supervisor: there };
    if (!moving) return { ok: true, version, updated, supervisor: "later" };
    this.restartingOnto = true;
    try {
      await this.until((s) => supervisorOn(version, s) !== null, RESTART_ONTO_MS, RESTART_ONTO_EVERY_MS, true);
    } finally {
      this.restartingOnto = false;
    }
    const end = await this.refresh();
    const where = supervisorOn(version, end);
    if (where) return { ok: true, version, updated, supervisor: where };
    return { ok: false, error: "not_restarted", detail: `v${version} is in place, but the supervisor here still runs v${end.cli.running ?? "?"}` };
  }

  // ── handing this computer to Mafold (activity center D6) ──
  //
  // A computer whose bots another mafold runs (`foreign`: another install's
  // service, a supervisor started by hand, the old `--no-auto-update`) is only
  // looked at — everything above refuses it. mafold-cli C10's `up --adopt`
  // moves it, and every bot on it, onto the mafold the shell runs: it waits
  // for the replies being written (up to 5 minutes), restarts each bot once,
  // and registers the service to run this binary, without the flag. The
  // person agrees to that in a native dialog naming the bots — a card on the
  // page can ask for it, never answer it — and it counts once this computer's
  // own status reads back as the shell's.

  /** Could this computer be handed to Mafold, and what would that restart?
   *  (`mafold up --adopt --check --json`); changes nothing. */
  async adoptCheck(): Promise<AdoptCheck> {
    const ready = await this.takeForAdopt();
    if (!ready.ok) return ready;
    try {
      return await this.checkAdopt();
    } catch (e) {
      return adoptFailed(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Hand this computer's bots to Mafold. Asked natively first — the bots it
   * restarts, and whether it updates itself afterwards — with the shell held
   * from the check to the end, so nothing else the shell does starts
   * meanwhile; checked again once the person said yes, and `changed` (nothing
   * done) if the computer isn't what they agreed to any more. Then `mafold up
   * --adopt --json`. It counts once this computer's own status reads back as
   * the shell's: running, every bot they agreed to running again as a new
   * process, and updates as the dialog said.
   */
  async adopt(): Promise<AdoptResult> {
    const ready = await this.takeForAdopt();
    if (!ready.ok) return ready;
    try {
      const check = await this.checkAdopt();
      if (!check.ok) return check;
      if (check.state === "managed") return { ok: true, adopted: false, bots: [], cut: [], autoUpdate: check.autoUpdate };
      if (check.state === "not_set_up") return { ok: false, error: "not_set_up" };
      if (!(await this.deps.confirm({ kind: "adopt", bots: check.bots, autoUpdate: check.autoUpdate }))) return { ok: false, error: "cancelled" };
      // A bot added or gone, or the setting changed, in a terminal while the dialog was up.
      const again = await this.checkAdopt();
      if (!again.ok) return again;
      if (again.state === "managed") return { ok: true, adopted: false, bots: [], cut: [], autoUpdate: again.autoUpdate };
      if (!sameAdopt(check, again)) {
        const said = (c: typeof check) => `${c.bots.join(", ") || "no bots"}, updates ${c.autoUpdate ? "on" : "off"}`;
        return { ok: false, error: "changed", detail: `agreed to ${said(check)}; this computer now has ${again.state === "adoptable" ? said(again) : again.state}` };
      }
      const pre = await this.status();
      const before = Object.fromEntries(
        check.bots.map((name) => {
          const b = pre.bots.find((x) => x.name === name);
          return [name, b?.running ? b.pid : undefined];
        }),
      );
      const env = await this.deps.env();
      const said = adoptSaid(await runCli(this.deps.paths, env, ["up", "--adopt", "--json"], ADOPT_MS));
      if ("error" in said) return { ok: false, ...said };
      if (said.ok === true && said.code === "managed") {
        // The shell's already (moved by someone else meanwhile): nothing to read back but that.
        if ((await this.refresh()).supervisor === "running") return { ok: true, adopted: false, bots: [], cut: [], autoUpdate: check.autoUpdate };
        return { ok: false, error: "unverified", detail: "the cli said this computer is the shell's already, but its status doesn't show it running" };
      }
      if (said.ok !== true || said.code !== "adopted") return { ok: false, ...adoptRefused(said) };
      const asked = { bots: check.bots, before, autoUpdate: check.autoUpdate };
      if (!(await this.until((s) => adoptReadsBack(asked, s), READ_BACK_MS, READ_BACK_EVERY_MS, true))) {
        return {
          ok: false,
          error: "unverified",
          detail: "the cli said it handed the bots over, but this computer's status doesn't show them running again on the shell's mafold, updates as agreed",
        };
      }
      return { ok: true, adopted: true, bots: check.bots, cut: adoptCut(said), autoUpdate: check.autoUpdate };
    } catch (e) {
      return adoptFailed(e);
    } finally {
      this.busy = false;
      void this.refresh();
    }
  }

  /** {@link take}, for the one thing asked of a supervisor that isn't the shell's. */
  private async takeForAdopt(): Promise<{ ok: true; s: DaemonStatus } | { ok: false; error: AdoptError; detail?: string }> {
    const t = await this.take({ moves: true, foreignOk: true });
    if (t.ok) return t;
    // Never `foreign` here (`foreignOk`).
    const error: AdoptError = t.error === "foreign" ? "failed" : t.error;
    return t.detail ? { ok: false, error, detail: t.detail } : { ok: false, error };
  }

  private async checkAdopt(): Promise<AdoptCheck> {
    const env = await this.deps.env();
    return readAdoptCheck(await runCli(this.deps.paths, env, ["up", "--adopt", "--check", "--json"], ADOPT_CHECK_MS));
  }

  /** Stop a sign-in that is still waiting, and a followed log (the app is quitting). */
  dispose(): void {
    this.login?.kill();
    if (this.signIn) this.stopSignIn(this.signIn);
    this.stopFollow(null, "closed");
  }
}

const logsArgs = (bot: string | null, lines: number, follow: boolean): string[] => [
  "logs",
  ...(bot === null ? [] : [bot]),
  "-n",
  String(lines),
  ...(follow ? ["-f"] : []),
  "--json",
];

/** `mafold logs` / `mafold diagnose` didn't do it: why, as the page is told,
 *  and what it printed, for the log. */
function cliFailed(what: string, r: Pick<RunResult, "stderr" | "timedOut"> & { code: number | null }): { error: LogError; detail?: string } {
  const error: LogError = r.timedOut ? "failed" : r.code === 0 ? "outdated" : cliLogError(r.stderr);
  const detail = r.timedOut ? "it didn't answer in time" : r.stderr.trim().slice(0, 300) || `exit ${r.code}`;
  log(`${what} failed: ${error} (${detail})`);
  return { error, detail };
}

/**
 * A followed log: `mafold logs … -f --json` running, what it prints going to
 * the page a frame at a time (`FRAME_EVERY_MS`), never more than a frame's
 * worth waiting (`LogBuffer`). The cli keeps reading until it is stopped.
 */
class Follow {
  private buf = new LogBuffer();
  private timer: NodeJS.Timeout;
  private ended = false;
  private stderr = "";

  constructor(
    readonly id: number,
    private child: ChildProcess,
    private send: (f: { id: number } & LogFrame) => void,
    private gone: (f: Follow) => void,
  ) {
    readLog(child, this.buf);
    child.stderr?.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-4000);
    });
    // `close`, not `exit`: by then everything it printed has been read.
    child.on("close", (code) => {
      const why = code === 0 ? "done" : cliLogError(this.stderr);
      if (why !== "done" && !this.ended) log(`logs -f ended: ${why} (${this.stderr.trim().slice(0, 300) || `exit ${code}`})`);
      this.end(why);
    });
    child.on("error", (e) => {
      if (!this.ended) log("logs -f didn't run:", e);
      this.end("failed");
    });
    this.timer = setInterval(() => this.flush(), FRAME_EVERY_MS);
  }

  stop(why: LogError): void {
    if (this.ended) return;
    this.end(why);
    this.child.kill();
  }

  private flush(): void {
    const frame = this.buf.take();
    if (frame) this.send({ id: this.id, ...frame });
  }

  private end(why: LogError | "done"): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.flush();
    this.send({ id: this.id, end: why });
    this.gone(this);
  }
}

/** A runtime sign-in under way. */
interface SignIn {
  child: ChildProcess;
  /** The sign-in page is out; the cli waits for the code. */
  linked: boolean;
  /** The code went to the cli. */
  coded: boolean;
  /** Stopped by the shell (cancel, a new sign-in, quitting). */
  cancelled: boolean;
  finished: Promise<RuntimeLoginResult>;
}

/** What `mafold logs --json` prints, into `buf`: its lines and rotations
 *  (`opened`: its first word). A line too long to hold is counted as skipped. */
function readLog(child: ChildProcess, buf: LogBuffer, opened: () => void = () => {}): void {
  lines(
    child,
    (line) => {
      const ev = readLogLine(line);
      if (ev?.type === "line") buf.push(ev.text);
      else if (ev?.type === "rotated") buf.rotate();
      else if (ev?.type === "open") opened();
    },
    { max: MAX_RAW_LINE, dropped: () => buf.skip() },
  );
}

/**
 * Each complete line `child` prints, trimmed. Decoded as one stream, so a
 * character split across two reads arrives whole. With `cap`, a line longer
 * than `max` characters is never held: it is dropped (`dropped`), and reading
 * picks up after its end.
 */
function lines(child: ChildProcess, each: (line: string) => void, cap?: { max: number; dropped: () => void }): void {
  const text = new StringDecoder("utf8");
  let buffer = "";
  let dropping = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += text.write(chunk);
    let start = 0;
    let nl: number;
    while ((nl = buffer.indexOf("\n", start)) >= 0) {
      const line = buffer.slice(start, nl);
      start = nl + 1;
      if (dropping) dropping = false;
      else each(line.trim());
    }
    buffer = buffer.slice(start);
    if (cap && buffer.length > cap.max) {
      if (!dropping) cap.dropped();
      dropping = true;
      buffer = "";
    }
  });
}
