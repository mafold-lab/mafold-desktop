// scripts/r2-publish.sh, run for real with `aws` stubbed on PATH: what a
// release puts on cdn.mafold.com/desktop/stable/, in what order. The version
// decides the line — X.Y.Z is everyone's, X.Y.Z-beta.N only the machines that
// opted in (src/main/updateChannel.ts) — and a beta must never touch a file a
// stable machine or the /download page reads.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { feedFile, PLATFORMS } from "./feedFile";

const SCRIPT = join(__dirname, "..", "scripts", "r2-publish.sh");
const PREFIX = "s3://bucket/desktop/stable/";
/** What the /download page links (mafold-web download/platforms.ts). */
const FIXED = ["Mafold-mac-arm64.dmg", "Mafold-mac-x64.dmg", "Mafold-Setup.exe"];
/** The feed files the updater fetches on a stable / a beta machine, per
 *  platform (in PLATFORMS order). */
let STABLE_FEEDS: string[] = [];
let BETA_FEEDS: string[] = [];
beforeAll(async () => {
  STABLE_FEEDS = await Promise.all(PLATFORMS.map((p) => feedFile("stable", p)));
  BETA_FEEDS = await Promise.all(PLATFORMS.map((p) => feedFile("beta", p)));
});

let dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mafold-r2-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** The versioned files electron-builder makes for `v` (the twelve of a
 *  release, less the two feeds). */
const versioned = (v: string): string[] => {
  const bins = [`Mafold-${v}-arm64.dmg`, `Mafold-${v}-x64.dmg`, `Mafold-${v}-arm64-mac.zip`, `Mafold-${v}-x64-mac.zip`, `Mafold-Setup-${v}.exe`];
  return [...bins, ...bins.map((f) => `${f}.blockmap`)];
};

/** A release directory as the build leaves it: the feeds under the names
 *  electron-builder picks from the version (`beta-*` for X.Y.Z-beta.N),
 *  announcing `says` (default: the version itself). */
function built(v: string, says = v): string {
  const d = temp();
  for (const f of versioned(v)) writeFileSync(join(d, f), f);
  const channel = v.includes("-beta.") ? "beta" : "latest";
  writeFileSync(join(d, `${channel}-mac.yml`), `version: ${says}\nfiles:\n  - url: Mafold-${v}-arm64-mac.zip\npath: Mafold-${v}-x64-mac.zip\n`);
  writeFileSync(join(d, `${channel}.yml`), `version: ${says}\nfiles:\n  - url: Mafold-Setup-${v}.exe\npath: Mafold-Setup-${v}.exe\n`);
  return d;
}

interface Upload {
  from: string;
  to: string;
  cache: string;
}

function publish(dir: string, v: string): { status: number | null; out: string; uploads: Upload[] } {
  const bin = temp();
  const log = join(bin, "aws.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash\nprintf '%s\\t' "$@" >> "${log}"\necho >> "${log}"\n`);
  chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", [SCRIPT, dir, v], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      R2_ACCOUNT_ID: "account",
      R2_BUCKET: "bucket",
    },
  });
  const uploads = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const a = line.replace(/\t$/, "").split("\t");
      expect(a.slice(0, 2)).toEqual(["s3", "cp"]);
      return { from: a.at(-2)!, to: a.at(-1)!, cache: a[a.indexOf("--cache-control") + 1] };
    });
  return { status: r.status, out: r.stdout + r.stderr, uploads };
}

const names = (us: Upload[]) => us.map((u) => u.to.slice(PREFIX.length));
/** Each upload as [the release file, the name it goes up under], in order. */
const pairs = (us: Upload[]) => us.map((u) => [u.from, u.to.slice(PREFIX.length)]);
const IMMUTABLE = "public, max-age=31536000, immutable";

describe("publishing a release to the CDN", () => {
  it("a stable release goes to everyone, and to the beta machines too", () => {
    const { status, out, uploads } = publish(built("0.1.4"), "0.1.4");
    expect(status, out).toBe(0);
    for (const u of uploads) expect(u.to.startsWith(PREFIX), u.to).toBe(true);
    const got = names(uploads);
    expect(got.slice(0, 10).sort()).toEqual(versioned("0.1.4").sort());
    for (const u of uploads.slice(0, 10)) expect(u.to).toBe(PREFIX + u.from);
    expect(uploads.slice(0, 10).every((u) => u.cache === IMMUTABLE)).toBe(true);
    // What the download page links, each from its own build.
    expect(pairs(uploads.slice(10, 13))).toEqual([
      ["Mafold-0.1.4-arm64.dmg", FIXED[0]],
      ["Mafold-0.1.4-x64.dmg", FIXED[1]],
      ["Mafold-Setup-0.1.4.exe", FIXED[2]],
    ]);
    // The feeds last — an app must never be told about a file not there yet:
    // each platform's stable feed under its own name, as always, then the very
    // same files under the beta names.
    expect(pairs(uploads.slice(13))).toEqual([
      ...PLATFORMS.map((_, i) => [STABLE_FEEDS[i], STABLE_FEEDS[i]]),
      ...PLATFORMS.map((_, i) => [STABLE_FEEDS[i], BETA_FEEDS[i]]),
    ]);
    for (const u of uploads.slice(10)) expect(u.cache).toBe("no-cache");
  });

  it("a beta goes only to the machines that opted in", () => {
    const { status, out, uploads } = publish(built("0.1.4-beta.2"), "0.1.4-beta.2");
    expect(status, out).toBe(0);
    for (const u of uploads) expect(u.to.startsWith(PREFIX), u.to).toBe(true);
    const got = names(uploads);
    expect(got.slice(0, 10).sort()).toEqual(versioned("0.1.4-beta.2").sort());
    for (const u of uploads.slice(0, 10)) expect(u.to).toBe(PREFIX + u.from);
    expect(uploads.slice(0, 10).every((u) => u.cache === IMMUTABLE)).toBe(true);
    expect(pairs(uploads.slice(10))).toEqual(PLATFORMS.map((_, i) => [BETA_FEEDS[i], BETA_FEEDS[i]]));
    for (const u of uploads.slice(10)) expect(u.cache).toBe("no-cache");
    // Nothing a stable machine or the download page reads.
    for (const f of [...STABLE_FEEDS, ...FIXED]) expect(got).not.toContain(f);
  });

  it("refuses any other kind of version, before uploading anything", () => {
    for (const v of ["0.1.4-rc.1", "0.1.4-alpha.1", "0.1.4-beta", "0.1.4-beta.1.2", "0.1.4-beta.x", "v0.1.4", "0.1", "0.1.4 "]) {
      const { status, uploads } = publish(built("0.1.4"), v);
      expect(status, v).not.toBe(0);
      expect(uploads, v).toEqual([]);
    }
  });

  it("refuses feeds that announce another version, before uploading anything", () => {
    for (const [v, says] of [
      ["0.1.4", "0.1.3"],
      ["0.1.4-beta.2", "0.1.4-beta.1"],
      ["0.1.4-beta.2", "0.1.4"],
    ]) {
      const { status, uploads } = publish(built(v, says), v);
      expect(status, `${v} saying ${says}`).not.toBe(0);
      expect(uploads).toEqual([]);
    }
  });

  it("refuses a build whose feeds are for the other line, before uploading anything", () => {
    // A beta's files published as a stable version would leave stable with no
    // feed of its own; a stable build published as a beta, the other way round.
    const beta = built("0.1.4-beta.2");
    const asStable = publish(beta, "0.1.4");
    expect(asStable.status).not.toBe(0);
    expect(asStable.uploads).toEqual([]);
    const stable = built("0.1.4");
    const asBeta = publish(stable, "0.1.4-beta.2");
    expect(asBeta.status).not.toBe(0);
    expect(asBeta.uploads).toEqual([]);
  });
});
