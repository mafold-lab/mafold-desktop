// The person's login-shell environment (PATH, proxies), read once — see
// model.ts `SHELL_VARS` for why the cli needs it.

import { execFile } from "node:child_process";

import { log } from "../log";
import { parseShellEnv, shellEnvScript } from "./model";

let cached: Promise<NodeJS.ProcessEnv> | null = null;

export function cliEnv(os: "macos" | "windows" | "linux", extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  cached ??= (async () => {
    // Windows apps inherit the user's environment from the registry already.
    if (os === "windows") return { ...process.env };
    const shell = process.env.SHELL || (os === "macos" ? "/bin/zsh" : "/bin/bash");
    const out = await new Promise<string>((resolve) => {
      execFile(shell, ["-ilc", shellEnvScript()], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) log("login shell env failed:", err.message);
        resolve(String(stdout ?? ""));
      });
    });
    return { ...process.env, ...parseShellEnv(out) };
  })();
  return cached.then((env) => ({ ...env, ...extra }));
}
