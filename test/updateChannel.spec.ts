import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PRODUCTION } from "../src/main/config";
import { CHANNEL_FILE, feedFor, feedOptions, parseUpdateChannel, readUpdateChannel } from "../src/main/updateChannel";
import { askedUrl, feedUrl } from "./feedFile";

let dirs: string[] = [];
const userData = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mafold-channel-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("which release line this computer updates from", () => {
  it("is stable when the shell has never been told otherwise", () => {
    expect(readUpdateChannel(userData())).toBe("stable");
  });

  it("is beta on a machine that opted in", () => {
    const d = userData();
    writeFileSync(join(d, CHANNEL_FILE), JSON.stringify({ channel: "beta" }));
    expect(readUpdateChannel(d)).toBe("beta");
  });

  it("is beta however a person wrote the file by hand", () => {
    // `echo … >` ends it with a newline; Windows editors and PowerShell's
    // `-Encoding UTF8` start it with a byte-order mark.
    for (const text of ['{"channel":"beta"}\n', '{"channel":"beta"}\r\n', '  { "channel" : "beta" }  ', '﻿{"channel":"beta"}', '{"channel":"beta","note":"x"}']) {
      expect(parseUpdateChannel(text), JSON.stringify(text)).toBe("beta");
    }
    const d = userData();
    writeFileSync(join(d, CHANNEL_FILE), '﻿{"channel":"beta"}\r\n');
    expect(readUpdateChannel(d)).toBe("beta");
  });

  it("is stable for anything else in the file", () => {
    for (const text of [
      "",
      "beta",
      "{",
      "null",
      "[]",
      '"beta"',
      '{"channel":"stable"}',
      '{"channel":"BETA"}',
      '{"channel":" beta"}',
      '{"channel":"alpha"}',
      '{"channel":"latest"}',
      '{"channel":["beta"]}',
      '{"channel":true}',
      '{"chanel":"beta"}',
    ]) {
      expect(parseUpdateChannel(text), text).toBe("stable");
    }
    expect(parseUpdateChannel(null)).toBe("stable");
    const d = userData();
    writeFileSync(join(d, CHANNEL_FILE), "\u0000ÿ garbage");
    expect(readUpdateChannel(d)).toBe("stable");
  });

  it("is stable when the file can't be read at all", () => {
    const d = userData();
    mkdirSync(join(d, CHANNEL_FILE));
    expect(readUpdateChannel(d)).toBe("stable");
  });

  it("keeps a stable machine on exactly the feed it reads today", async () => {
    expect(feedOptions("https://cdn.mafold.com/desktop/stable/", "stable")).toEqual({
      provider: "generic",
      url: "https://cdn.mafold.com/desktop/stable/",
    });
    expect(await feedUrl("stable", "darwin")).toBe("https://cdn.mafold.com/desktop/stable/latest-mac.yml");
    expect(await feedUrl("stable", "win32")).toBe("https://cdn.mafold.com/desktop/stable/latest.yml");
  });

  it("points a beta machine at the beta files of the same feed", async () => {
    expect(feedOptions("https://cdn.mafold.com/desktop/stable/", "beta")).toEqual({
      provider: "generic",
      url: "https://cdn.mafold.com/desktop/stable/",
      channel: "beta",
    });
    expect(await feedUrl("beta", "darwin")).toBe("https://cdn.mafold.com/desktop/stable/beta-mac.yml");
    expect(await feedUrl("beta", "win32")).toBe("https://cdn.mafold.com/desktop/stable/beta.yml");
  });

  it("is what a packaged shell hands its updater: the data directory alone decides", async () => {
    // updater.ts passes feedFor(userData, feed) to setFeedURL as it is —
    // updater.spec.ts starts it as a packaged shell and holds it to that.
    const feed = PRODUCTION.updateFeed!;
    const d = userData();
    const asked = async () => Promise.all([askedUrl(feedFor(d, feed), "darwin"), askedUrl(feedFor(d, feed), "win32")]);
    expect(feedFor(d, feed)).toEqual(feedOptions(feed, "stable"));
    expect(await asked()).toEqual(["https://cdn.mafold.com/desktop/stable/latest-mac.yml", "https://cdn.mafold.com/desktop/stable/latest.yml"]);

    writeFileSync(join(d, CHANNEL_FILE), '{"channel":"beta"}\n');
    expect(feedFor(d, feed)).toEqual(feedOptions(feed, "beta"));
    expect(await asked()).toEqual(["https://cdn.mafold.com/desktop/stable/beta-mac.yml", "https://cdn.mafold.com/desktop/stable/beta.yml"]);
    // Another machine's data directory is not this one's.
    expect(await askedUrl(feedFor(userData(), feed), "darwin")).toBe("https://cdn.mafold.com/desktop/stable/latest-mac.yml");

    // Deleting the file goes back to stable.
    rmSync(join(d, CHANNEL_FILE));
    expect(await asked()).toEqual(["https://cdn.mafold.com/desktop/stable/latest-mac.yml", "https://cdn.mafold.com/desktop/stable/latest.yml"]);
  });
});
