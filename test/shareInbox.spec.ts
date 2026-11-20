import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { takeShare } from "../src/main/shareInbox";
import { MAX_SHARE_BYTES } from "../src/shared/desktopHost.generated";

let inbox: string;
beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), "share-inbox-"));
});
afterEach(() => rmSync(inbox, { recursive: true, force: true }));

function put(id: string, manifest: unknown, files: Record<string, string> = {}, at?: number): string {
  const dir = join(inbox, id);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const path = join(dir, "manifest.json");
  writeFileSync(path, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  if (at) utimesSync(path, at / 1000, at / 1000);
  return dir;
}

const text = (b: Uint8Array) => Buffer.from(b).toString();

describe("takeShare", () => {
  it("hands a share over once", async () => {
    put("a", { text: "hello", files: [{ name: "a.txt", mime: "text/plain" }] }, { "a.txt": "bytes" });
    const got = await takeShare(inbox);
    expect(got?.text).toBe("hello");
    expect(got?.skipped).toBe(0);
    expect(got?.files.map((f) => [f.name, f.mime, text(f.bytes)])).toEqual([["a.txt", "text/plain", "bytes"]]);
    expect(readdirSync(inbox)).toEqual([]);
    expect(await takeShare(inbox)).toBeNull();
  });

  it("takes the oldest first", async () => {
    const now = Date.now();
    put("new", { text: "second", files: [] }, {}, now - 1000);
    put("old", { text: "first", files: [] }, {}, now - 5000);
    expect((await takeShare(inbox))?.text).toBe("first");
    expect((await takeShare(inbox))?.text).toBe("second");
  });

  it("leaves a folder still being written", async () => {
    mkdirSync(join(inbox, "writing"));
    expect(await takeShare(inbox)).toBeNull();
    expect(readdirSync(inbox)).toEqual(["writing"]);
  });

  it("clears a folder its writer abandoned", async () => {
    mkdirSync(join(inbox, "dead"));
    expect(await takeShare(inbox, Date.now() + 2 * 60 * 60 * 1000)).toBeNull();
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("drops a manifest it can't read and moves on", async () => {
    const now = Date.now();
    put("bad", "{not json", {}, now - 5000);
    put("good", { text: "ok", files: [] }, {}, now - 1000);
    expect((await takeShare(inbox))?.text).toBe("ok");
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("reads only plain files in the share's own folder", async () => {
    const secret = join(inbox, "..", `share-secret-${process.pid}`);
    writeFileSync(secret, "secret");
    const dir = put(
      "a",
      {
        text: "",
        files: [
          { name: `../${secret}`, mime: "text/plain" },
          { name: "/etc/hosts", mime: "text/plain" },
          { name: "manifest.json", mime: "application/json" },
          { name: "link", mime: "text/plain" },
          { name: "missing", mime: "text/plain" },
          { name: "fine.txt", mime: "text/plain" },
        ],
      },
      { "fine.txt": "ok" },
    );
    symlinkSync(secret, join(dir, "link"));
    const got = await takeShare(inbox);
    rmSync(secret);
    expect(got?.files.map((f) => f.name)).toEqual(["fine.txt"]);
    expect(got?.skipped).toBe(5);
  });

  it("counts a file past the limit as skipped", async () => {
    const dir = put("a", { text: "", files: [{ name: "big.bin", mime: "application/octet-stream" }] });
    writeFileSync(join(dir, "big.bin"), "");
    // Sparse: past the limit in size, nothing on disk.
    const { truncateSync } = await import("node:fs");
    truncateSync(join(dir, "big.bin"), MAX_SHARE_BYTES + 1);
    const got = await takeShare(inbox);
    expect(got?.files).toEqual([]);
    expect(got?.skipped).toBe(1);
  });
});
