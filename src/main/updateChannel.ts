// Which release line this computer's shell updates from. Everyone is on
// `stable`. An internal machine can opt into `beta` — every `X.Y.Z-beta.N`
// build, and every stable release too — with one file in the shell's data
// directory, beside window-state.json:
//
//   update-channel.json   {"channel":"beta"}
//
// (macOS ~/Library/Application Support/Mafold/, Windows %APPDATA%\Mafold\).
// Nothing in the app shows or sets it; it is read once at launch, so a change
// takes effect on the next start. Deleting it goes back to stable. Missing,
// unreadable or anything else in it ⇒ stable.
//
// Both lines share the one feed (config.ts `updateFeed`) and are told apart by
// electron-updater's own channel files: stable reads `latest-mac.yml` /
// `latest.yml`, beta `beta-mac.yml` / `beta.yml`. A beta build writes only its
// beta files, a stable release writes both (scripts/r2-publish.sh). The
// channel goes into the feed's options rather than `autoUpdater.channel`,
// whose setter also allows downgrades: a machine leaving beta stays on the
// beta it has until a stable release passes it.
//
// Pure except for the file read, like notifyPermission.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type UpdateChannel = "stable" | "beta";

/** In userData. */
export const CHANNEL_FILE = "update-channel.json";

/** The file's text, or null when there is none. The one file here a person
 *  writes by hand: a byte-order mark in front (Windows editors, PowerShell's
 *  `-Encoding UTF8`) is not a different file. */
export function parseUpdateChannel(text: string | null): UpdateChannel {
  try {
    const c = (JSON.parse((text ?? "").replace(/^﻿/, "")) as { channel?: unknown } | null)?.channel;
    return c === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

export function readUpdateChannel(dir: string): UpdateChannel {
  let text: string | null = null;
  try {
    text = readFileSync(join(dir, CHANNEL_FILE), "utf8");
  } catch {
    /* not opted in */
  }
  return parseUpdateChannel(text);
}

/** What electron-updater's `setFeedURL` takes: our generic feed. */
export type FeedOptions = { provider: "generic"; url: string; channel?: string };

/** electron-updater's generic feed for `channel`: stable is the feed exactly
 *  as it always was (its default `latest` files). */
export function feedOptions(url: string, channel: UpdateChannel): FeedOptions {
  return channel === "beta" ? { provider: "generic", url, channel: "beta" } : { provider: "generic", url };
}

/** What a packaged shell hands `setFeedURL` (updater.ts, as it is): the feed
 *  `url`, for the line its data directory `userData` says this machine is on.
 *  The one place the file and the feed meet — test/updateChannel.spec.ts runs
 *  it against a real data directory and electron-updater's own provider, and
 *  test/updater.spec.ts holds updater.ts to handing it over unchanged. */
export function feedFor(userData: string, url: string): FeedOptions {
  return feedOptions(url, readUpdateChannel(userData));
}
