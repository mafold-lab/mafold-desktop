// Third-party authorization from the desktop: the page asks, the shell opens
// the provider in the SYSTEM browser (where the person is already signed in,
// and where Google allows sign-in at all), and the provider's redirect lands on
// `<web>/app/link/callback` there. That page, seeing a `dsk_` state and no
// opener, bounces to `mafold://link?…`, which the OS hands back to us.
//
// Anyone can open a `mafold://link` URL, so the only results accepted are for
// a state THIS shell registered, not yet used, not yet expired. A code that
// arrives for another state is dropped without a word. (A code injected for a
// matching state is still useless without the PKCE verifier, which never left
// the page.)

import { isDesktopState, type OAuthResult } from "../shared/desktopHost.generated";

export const OAUTH_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 8;
const STATE_RE = /^[A-Za-z0-9_\-.~]{12,256}$/;

interface Pending {
  resolve: (r: OAuthResult) => void;
  expiresAt: number;
}

export class PendingAuth {
  private table = new Map<string, Pending>();

  /** Register `state`. `accepted` is false (and `result` already settled with
   *  the reason) for a malformed or already-pending state; otherwise `result`
   *  settles when the matching link arrives, or with `{ error }` when it
   *  expires or is crowded out. */
  begin(state: string, now: number): { accepted: boolean; result: Promise<OAuthResult> } {
    if (!isDesktopState(state) || !STATE_RE.test(state)) {
      return { accepted: false, result: Promise.resolve({ error: "invalid state" }) };
    }
    if (this.table.has(state)) return { accepted: false, result: Promise.resolve({ error: "state already pending" }) };
    this.sweep(now);
    if (this.table.size >= MAX_PENDING) {
      // The oldest is the one the person has most likely abandoned.
      const [oldest, p] = this.table.entries().next().value as [string, Pending];
      this.table.delete(oldest);
      p.resolve({ error: "superseded" });
    }
    const result = new Promise<OAuthResult>((resolve) => {
      this.table.set(state, { resolve, expiresAt: now + OAUTH_TTL_MS });
    });
    return { accepted: true, result };
  }

  /** Deliver a result. True if it matched a live pending state (and was used up). */
  deliver(state: string, result: OAuthResult, now: number): boolean {
    const p = this.table.get(state);
    if (!p) return false;
    this.table.delete(state);
    if (p.expiresAt <= now) {
      p.resolve({ error: "timed out" });
      return false;
    }
    p.resolve(result);
    return true;
  }

  sweep(now: number): void {
    for (const [state, p] of this.table) {
      if (p.expiresAt <= now) {
        this.table.delete(state);
        p.resolve({ error: "timed out" });
      }
    }
  }

  get size(): number {
    return this.table.size;
  }
}
