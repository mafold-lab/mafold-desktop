// `mafold://` — the one scheme the shell registers with the OS.
//
//   mafold://app#<hash>          open the app at an in-app hash (the same shape
//                                RN registers on phones: `mafold://app#<conv>`)
//   mafold://link?code=…&state=… the system browser handing back an OAuth result
//
// The shell does not judge which hashes are meaningful — that is the page's
// `isAppHash` (mafold-web lib/appHash.ts), the one place that rule lives. It
// only refuses anything that cannot be a hash at all.

import { DEEP_LINK_SCHEME, MAX_DEEP_LINK_HASH } from "../shared/desktopHost.generated";

export type DeepLink =
  | { kind: "app"; hash: string }
  | { kind: "link"; state: string; code?: string; error?: string };

const PREFIX = `${DEEP_LINK_SCHEME}://`;

// Printable, no whitespace — a hash is an identifier path, never prose.
const HASH_RE = /^#[\x21-\x7e]+$/;

export function parseDeepLink(raw: string): DeepLink | null {
  if (typeof raw !== "string" || !raw.toLowerCase().startsWith(PREFIX)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.host === "app") {
    const hash = u.hash;
    if (hash.length < 2 || hash.length > MAX_DEEP_LINK_HASH || !HASH_RE.test(hash)) return null;
    return { kind: "app", hash };
  }
  if (u.host === "link") {
    const q = u.searchParams;
    const state = q.get("state") ?? "";
    if (!state) return null;
    const error = q.get("error");
    const desc = q.get("error_description");
    return {
      kind: "link",
      state,
      code: q.get("code") ?? undefined,
      error: error ? (desc ? `${error}: ${desc}` : error) : undefined,
    };
  }
  return null;
}

/** On Windows (and Linux) a deep link arrives as a command-line argument —
 *  of the first launch, or of a second instance handed to the first. */
export const deepLinkInArgv = (argv: readonly string[]): string | null =>
  argv.find((a) => typeof a === "string" && a.toLowerCase().startsWith(PREFIX)) ?? null;
