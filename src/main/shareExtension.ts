// Puts Mafold in the macOS share menu without a trip to System Settings.
//
// macOS installs a share extension switched off, and the switch is three levels
// down (General ▸ Login Items & Extensions ▸ Sharing), so almost nobody would
// find it. `pluginkit` is the same switch from the command line. It is thrown
// once per computer, and only while nobody has touched it: `-` means the person
// switched it off, and a person's no stays no. The file in userData makes it
// once, so an off that pluginkit doesn't report as `-` is still never undone.
//
// `pluginkit -m -A -i` reads `+    com.mafold.desktop.share(0.1.5)`: `+` in use,
// `-` ignored, a blank nobody chose yet, nothing at all when macOS has not
// found the extension yet (which is why the first launch waits for it).

import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./log";

/** share-extension/mac/Info.plist */
export const SHARE_EXTENSION_ID = "com.mafold.desktop.share";

/** In userData: the switch has had its one go. */
export const SHARE_EXTENSION_FILE = "share-extension.json";

const PLUGINKIT = "/usr/bin/pluginkit";
const TIMEOUT_MS = 10_000;
/** A fresh install: how long macOS gets to find the extension, this launch. */
const LOOKS = 5;
const LOOK_EVERY_MS = 2_000;

export type Election = "on" | "off" | "undecided" | "missing";

/** `pluginkit -m -A -i`'s output. A mark this doesn't know is left alone. */
export function parseElection(output: string, id = SHARE_EXTENSION_ID): Election {
  const line = output.split("\n").find((l) => l.includes(`${id}(`));
  if (line === undefined) return "missing";
  const mark = line[0];
  if (mark === "+") return "on";
  return mark === " " || mark === "\t" ? "undecided" : "off";
}

/** Runs pluginkit, resolves its stdout, rejects when it fails. */
export type Pluginkit = (args: string[]) => Promise<string>;

export interface SwitchDeps {
  pluginkit: Pluginkit;
  sleep: (ms: number) => Promise<void>;
}

/** Switches `appex` on unless someone chose. True once there is nothing left
 *  to do; false means macOS still has no answer, so the next launch tries. */
export async function switchOnOnce(appex: string, { pluginkit, sleep }: SwitchDeps): Promise<boolean> {
  const read = async () => parseElection(await pluginkit(["-m", "-A", "-i", SHARE_EXTENSION_ID]));
  await pluginkit(["-a", appex]);
  let election = await read();
  for (let look = 1; election === "missing" && look < LOOKS; look++) {
    await sleep(LOOK_EVERY_MS);
    election = await read();
  }
  if (election === "missing") return false;
  if (election !== "undecided") return true;
  await pluginkit(["-e", "use", "-i", SHARE_EXTENSION_ID]);
  return (await read()) === "on";
}

const runPluginkit: Pluginkit = (args) =>
  new Promise((resolve, reject) => {
    execFile(PLUGINKIT, args, { timeout: TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** A packaged app in Applications, on a launch's way up. Never throws. From the
 *  disk image the extension would be registered at a path about to vanish. */
export async function enableShareExtension(userData: string, appex: string): Promise<void> {
  const done = join(userData, SHARE_EXTENSION_FILE);
  if (existsSync(done)) return;
  try {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    if (!(await switchOnOnce(appex, { pluginkit: runPluginkit, sleep }))) {
      log("share extension: not found yet");
      return;
    }
    writeFileSync(done, "{}\n");
    log("share extension: settled");
  } catch (e) {
    log("share extension:", e instanceof Error ? e : String(e));
  }
}
