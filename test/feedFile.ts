// The feed file a packaged shell asks the CDN for: electron-updater's own
// generic provider, given what the shell hands it (updateChannel.ts `feedFor`,
// from the shell's data directory — updater.ts passes it straight to
// `setFeedURL`, updater.spec.ts), asked for the latest version — with the request caught
// instead of sent. So the names the tests hold the shell and the publish
// script to can't drift from what the updater really fetches.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GenericProvider } from "electron-updater/out/providers/GenericProvider";

import { PRODUCTION } from "../src/main/config";
import { CHANNEL_FILE, feedFor, type FeedOptions, type UpdateChannel } from "../src/main/updateChannel";

/** The two platforms the shell ships for, as electron-updater names them. */
export const PLATFORMS = ["darwin", "win32"] as const;
type Platform = (typeof PLATFORMS)[number];

const FEED = "version: 0.1.4\nfiles:\n  - url: Mafold-0.1.4-arm64-mac.zip\n    sha512: x\npath: Mafold-0.1.4-arm64-mac.zip\nsha512: x\n";

/** The URL the updater fetches, on `platform`, given `options`. */
export async function askedUrl(options: FeedOptions, platform: Platform): Promise<string> {
  const asked: { protocol?: string; hostname?: string; path?: string }[] = [];
  const executor = {
    request: async (o: (typeof asked)[number]) => {
      asked.push(o);
      return FEED;
    },
  };
  const updater = { channel: null, isAddNoCacheQuery: false };
  const p = new GenericProvider(options, updater as never, {
    platform,
    isUseMultipleRangeRequest: true,
    executor: executor as never,
  });
  await p.getLatestVersion();
  if (asked.length !== 1) throw new Error(`the updater made ${asked.length} requests, not one`);
  const [o] = asked;
  return `${o.protocol}//${o.hostname}${o.path}`;
}

/** The URL the updater fetches, on `platform`, for a machine on `channel`:
 *  a data directory that says so (nothing in it, for stable). */
export async function feedUrl(channel: UpdateChannel, platform: Platform): Promise<string> {
  const userData = mkdtempSync(join(tmpdir(), "mafold-feed-"));
  try {
    if (channel !== "stable") writeFileSync(join(userData, CHANNEL_FILE), JSON.stringify({ channel }));
    return await askedUrl(feedFor(userData, PRODUCTION.updateFeed!), platform);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

/** Just the file name — what the publish script uploads. */
export const feedFile = async (channel: UpdateChannel, platform: Platform): Promise<string> =>
  (await feedUrl(channel, platform)).split("/").pop()!;
