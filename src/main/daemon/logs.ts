// This computer's logs as the page sees them (activity center D4) — pure, so
// the limits are unit-tested without a cli (test/daemonLogs.spec.ts).
//
// mafold-cli finds each log (`mafold logs [bot] --json`, the very paths
// `status --json` gives): the shell never builds a path itself. What it adds
// is the page's side of the limits — how much one read hands over, how fast a
// followed log reaches the page, and how big one frame of it may be.

import type { DaemonStatus, LogError } from "../../shared/desktopHost.generated";
import { isOwnBot, sameAccount } from "./model";

/** The most lines one read (or a follow's start) asks the cli for. */
export const MAX_LOG_LINES = 500;
/** One line longer than this is cut, ending in `…`. */
export const MAX_LINE_CHARS = 4000;
/** One frame of a followed log, as the page receives it: at most this much
 *  of JSON-encoded lines, and this many lines. */
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_FRAME_LINES = 1000;
/** How often a followed log sends what it has: at most four frames a second. */
export const FRAME_EVERY_MS = 250;
/** A one-off read hands over at most this much. */
export const MAX_TAIL_BYTES = 256 * 1024;
/** The cli doesn't cut lines: one longer than this (as it prints it, JSON) is
 *  never held whole — it is dropped, counted with the skipped ones. */
export const MAX_RAW_LINE = 1024 * 1024;

export const clipLine = (s: string): string => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s);

/** What a line costs in a frame: its JSON encoding and the comma after it. */
const cost = (line: string): number => JSON.stringify(line).length + 1;

/**
 * Lines waiting for the next frame. It never holds more than one frame's
 * worth: when lines come faster than frames go, the oldest are dropped and
 * counted — a person following a log wants what is happening now.
 */
export class LogBuffer {
  private lines: string[] = [];
  private costs: number[] = [];
  private bytes = 0;
  private skipped = 0;
  private rotated = false;

  constructor(
    private readonly maxBytes = MAX_FRAME_BYTES,
    private readonly maxLines = MAX_FRAME_LINES,
  ) {}

  push(text: string): void {
    const line = clipLine(text);
    const c = cost(line);
    this.lines.push(line);
    this.costs.push(c);
    this.bytes += c;
    // A clipped line costs far less than a frame, so the newest always stays.
    while (this.lines.length > 1 && (this.bytes > this.maxBytes || this.lines.length > this.maxLines)) {
      this.lines.shift();
      this.bytes -= this.costs.shift() ?? 0;
      this.skipped++;
    }
  }

  rotate(): void {
    this.rotated = true;
  }

  /** A line that never made it in (too long to hold). */
  skip(): void {
    this.skipped++;
  }

  /** Everything waiting, as one frame — null when there is nothing. */
  take(): { lines?: string[]; skipped?: number; rotated?: true } | null {
    if (!this.lines.length && !this.skipped && !this.rotated) return null;
    const frame = {
      ...(this.lines.length ? { lines: this.lines } : {}),
      ...(this.skipped ? { skipped: this.skipped } : {}),
      ...(this.rotated ? { rotated: true as const } : {}),
    };
    this.lines = [];
    this.costs = [];
    this.bytes = 0;
    this.skipped = 0;
    this.rotated = false;
    return frame;
  }
}

/** How many lines to ask for: 1–500, whatever the page sent. */
export const lineCount = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(n))) : 40;

/** One line of `mafold logs --json` (mafold-cli supervisor.rs `logs`). */
export type LogLine = { type: "open"; path?: string } | { type: "line"; text: string } | { type: "rotated" };

export function readLogLine(line: string): LogLine | null {
  if (!line.startsWith("{")) return null;
  let v: { type?: unknown; text?: unknown; path?: unknown };
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (v?.type === "line" && typeof v.text === "string") return { type: "line", text: v.text };
  if (v?.type === "rotated") return { type: "rotated" };
  if (v?.type === "open") return typeof v.path === "string" ? { type: "open", path: v.path } : { type: "open" };
  return null;
}

/** Why `mafold logs` / `mafold diagnose` gave up, from what it printed. */
export function cliLogError(stderr: string): LogError {
  // A mafold from before `logs` / `diagnose` (or before their `--json`)
  // answers with clap's usage error.
  if (/unrecognized subcommand|unexpected argument|wasn't expected/i.test(stderr)) return "outdated";
  if (/no log for|no supervisor log yet/i.test(stderr)) return "no_log";
  return "failed";
}

/**
 * May the person the page is signed in as read this log? A bot's: only one of
 * their own (a bot is `owner:bot`) that runs here. The supervisor's — it
 * speaks of every bot on this computer — only someone signed in on it.
 */
export function mayReadLog(username: string, bot: string | null, s: DaemonStatus): LogError | null {
  if (bot !== null && !isOwnBot(bot, username)) return "not_yours";
  if (!s.cli.installed) return "cli_missing";
  if (bot === null) return s.accounts.some((a) => sameAccount(a, username)) ? null : "not_yours";
  return s.bots.some((b) => b.name === bot) ? null : "unknown_bot";
}

/** `mafold-diagnose-20261029-091502.json`, in UTC — the cli's own default. */
export function diagnoseName(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `mafold-diagnose-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.json`;
}
