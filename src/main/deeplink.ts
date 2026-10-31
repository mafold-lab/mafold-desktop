// `mafold://` — the one scheme the shell registers with the OS.
//
//   mafold://app#<hash>          open the app at an in-app hash (the same shape
//                                RN registers on phones: `mafold://app#<conv>`)
//   mafold://link?code=…&state=… the system browser handing back an OAuth result
//
// 深链这里不判断哪个 hash 是个地方,只拒掉根本不可能是 hash 的东西;是不是地方由页面读 hash 时定
// (AppShell 的 openFromHash)。那条规则网页和壳只用一份:client-shared/reloadLanding.ts 的 `landingFromHash`
// —— 网页 AppShell 读 hash、消息里的站内链接(lib/appHash.ts `isAppHash`)都用它;壳自己只在
// relaunch.ts(重启后落回哪)用它的生成副本,深链不用。手机 RN 那份(mafold-rn/src/lib/appHash.ts
// 的 `APP_HASH_RE`)归 M12 并进来。

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
