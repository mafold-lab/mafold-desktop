// What other apps shared to Mafold, waiting on disk for the page.
//
// The share extension (share-extension/) is a separate sandboxed process that
// can reach this app only through their App Group folder. It writes one folder
// per share under `Inbox/`, the files first and `manifest.json` last, then opens
// `mafold://share`. A folder with no manifest is therefore still being written.
//
// A share leaves the inbox when the page takes it, so it can be sent once. A
// launch that never got the link still finds it: the page asks on start.

import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MAX_SHARE_BYTES, type HostShare, type HostShareFile } from "../shared/desktopHost.generated";

/** The App Group both sides claim (build/entitlements.mac.plist,
 *  share-extension/mac/MafoldShare.entitlements). */
export const SHARE_APP_GROUP = "UGZPUZZYDD.com.mafold.share";

/** An unfinished folder this old lost its writer. */
const ABANDONED_MS = 60 * 60 * 1000;

export const shareInboxDir = (): string => join(homedir(), "Library", "Group Containers", SHARE_APP_GROUP, "Inbox");

interface Manifest {
  text: string;
  files: { name: string; mime: string }[];
}

function readManifest(raw: string): Manifest | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { text, files } = v as { text?: unknown; files?: unknown };
  if (typeof text !== "string" || !Array.isArray(files)) return null;
  const rows = files.flatMap((f: unknown) => {
    const { name, mime } = (f ?? {}) as { name?: unknown; mime?: unknown };
    return typeof name === "string" && typeof mime === "string" ? [{ name, mime }] : [];
  });
  return { text, files: rows };
}

/** One file's bytes, if it is a plain file in this share's own folder and still
 *  fits. `basename` and the `lstat` keep a manifest from naming anything else. */
async function readFileIn(dir: string, name: string, left: number): Promise<Uint8Array | null> {
  const own = basename(name);
  if (own !== name || name === "manifest.json") return null;
  const path = join(dir, own);
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.size > left) return null;
  return readFile(path);
}

async function takeOne(dir: string): Promise<HostShare | null> {
  const raw = await readFile(join(dir, "manifest.json"), "utf8");
  const manifest = readManifest(raw);
  if (!manifest) return null;
  const files: HostShareFile[] = [];
  let left = MAX_SHARE_BYTES;
  let skipped = 0;
  for (const f of manifest.files) {
    const bytes = await readFileIn(dir, f.name, left);
    if (!bytes) {
      skipped += 1;
      continue;
    }
    left -= bytes.length;
    files.push({ name: f.name, mime: f.mime, bytes });
  }
  return { text: manifest.text, files, skipped };
}

/** The oldest share in `inbox`, which leaves it. Folders that can't be read as
 *  a share are dropped rather than asked about again on every start. */
export async function takeShare(inbox: string, now: number = Date.now()): Promise<HostShare | null> {
  const names = await readdir(inbox).catch(() => [] as string[]);
  const waiting: { dir: string; at: number }[] = [];
  for (const name of names) {
    const dir = join(inbox, name);
    const at = await stat(join(dir, "manifest.json")).then((s) => s.mtimeMs).catch(() => null);
    if (at !== null) {
      waiting.push({ dir, at });
      continue;
    }
    const since = await lstat(dir).then((s) => s.mtimeMs).catch(() => now);
    if (now - since > ABANDONED_MS) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  waiting.sort((a, b) => a.at - b.at);
  for (const { dir } of waiting) {
    const share = await takeOne(dir).catch(() => null);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (share && (share.text || share.files.length || share.skipped)) return share;
  }
  return null;
}
