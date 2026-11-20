// One small log file in the app's logs directory, for support. Rotated once at
// 1 MB (`main.log` → `main.old.log`). Never logs page content, tokens or URLs
// with query strings — only what the shell itself decided.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

let file: string | null = null;

export function initLog(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    file = join(dir, "main.log");
    if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, join(dir, "main.old.log"));
  } catch {
    file = null;
  }
}

export function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.message : String(p))).join(" ")}\n`;
  if (!file) {
    process.stderr.write(line);
    return;
  }
  try {
    appendFileSync(file, line);
  } catch {
    process.stderr.write(line);
  }
}

/** A URL reduced to what is safe to write down: origin + path, no query/hash. */
export const redact = (raw: string): string => {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<not a url>";
  }
};
