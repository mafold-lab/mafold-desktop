// Small guards the main process puts around things a page can trigger.

/** At most one call per `intervalMs` per key. A page (or a card running inside
 *  it) cannot turn `openExternal` or popups into a browser-tab fountain. */
export class RateLimit {
  private last = new Map<string, number>();
  constructor(private intervalMs: number) {}

  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    return true;
  }
}

/** A name that does not collide with an existing file: `a.pdf`, `a (1).pdf`, … */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "download";
  if (!taken(clean)) return clean;
  const dot = clean.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** Clamp a page-supplied string before it reaches a native surface. */
export const clip = (s: unknown, max: number): string => (typeof s === "string" ? s.slice(0, max) : "");
