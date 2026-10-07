// Where the shell points. A packaged build always talks to production and
// ignores the environment; an unpackaged one (`npm start`, the e2e suite) may be
// pointed at a local web and api — and only then, so no env var can ever turn a
// shipped app into a window onto somebody else's page.

export interface ShellConfig {
  /** The web app's origin. The only origin the window shows and the bridge serves. */
  webOrigin: string;
  /** What the window opens. */
  startUrl: string;
  /** The api origin: its `/download/<id>` responses are file downloads. */
  apiOrigin: string;
  /** electron-updater's generic feed, or null when updates are off (unpackaged). */
  updateFeed: string | null;
  /** Unpackaged only: where e2e keeps this run's userData / downloads, and
   *  where `openExternal` is recorded instead of performed; the mafold home
   *  and cli binary the daemon manager uses instead of `~/.mafold` and the
   *  bundled one; and the answer every confirmation dialog gets. */
  test: {
    userData?: string;
    downloads?: string;
    externalLog?: string;
    mafoldHome?: string;
    cli?: string;
    confirm?: "yes" | "no";
  } | null;
}

export const PRODUCTION: Omit<ShellConfig, "test"> = {
  webOrigin: "https://mafold.com",
  startUrl: "https://mafold.com/app",
  apiOrigin: "https://api.mafold.com",
  updateFeed: "https://cdn.mafold.com/desktop/stable/",
};

const origin = (raw: string, name: string): string => {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} must be http(s): ${raw}`);
  return u.origin;
};

export function resolveConfig(env: Record<string, string | undefined>, packaged: boolean): ShellConfig {
  if (packaged) return { ...PRODUCTION, test: null };
  const webOrigin = env.MAFOLD_DESKTOP_WEB ? origin(env.MAFOLD_DESKTOP_WEB, "MAFOLD_DESKTOP_WEB") : PRODUCTION.webOrigin;
  const apiOrigin = env.MAFOLD_DESKTOP_API ? origin(env.MAFOLD_DESKTOP_API, "MAFOLD_DESKTOP_API") : PRODUCTION.apiOrigin;
  const path = env.MAFOLD_DESKTOP_START_PATH ?? "/app";
  const answer = env.MAFOLD_DESKTOP_TEST_CONFIRM;
  const confirm: "yes" | "no" | undefined = answer === "yes" || answer === "no" ? answer : undefined;
  const test =
    env.MAFOLD_DESKTOP_USER_DATA || env.MAFOLD_DESKTOP_DOWNLOADS || env.MAFOLD_DESKTOP_EXTERNAL_LOG || env.MAFOLD_DESKTOP_MAFOLD_HOME || env.MAFOLD_DESKTOP_CLI || confirm
      ? {
          userData: env.MAFOLD_DESKTOP_USER_DATA,
          downloads: env.MAFOLD_DESKTOP_DOWNLOADS,
          externalLog: env.MAFOLD_DESKTOP_EXTERNAL_LOG,
          mafoldHome: env.MAFOLD_DESKTOP_MAFOLD_HOME,
          cli: env.MAFOLD_DESKTOP_CLI,
          confirm,
        }
      : null;
  return { webOrigin, startUrl: new URL(path, webOrigin).toString(), apiOrigin, updateFeed: null, test };
}
