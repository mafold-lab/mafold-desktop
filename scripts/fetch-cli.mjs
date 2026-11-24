// Fetch the mafold-cli build this app bundles into bin/<platform>-<arch>/ —
// exactly the version and checksums pinned in cli.lock.json, never "latest":
// rebuilding the same desktop@ tag must bundle the same bytes, and a release
// the cli repo is still publishing must not be picked up half-done.
//
//   node scripts/fetch-cli.mjs --mac [--check]
//   node scripts/fetch-cli.mjs --win [--check]
//
// --check runs the binary for this machine and requires `mafold status --json`
// to answer with a JSON status: the shell's daemon manager depends on it
// (src/main/daemon/manager.ts), and a cli from before it would ship an app
// that cannot tell whose supervisor it is looking at. Bumping the pin is a
// one-line commit after a cli@ release.
//
// The binaries keep the signatures their own release gave them (Developer ID +
// hardened runtime on macOS) — electron-builder is told not to re-sign them
// (electron-builder.yml `mac.signIgnore`).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "cli.lock.json"), "utf8"));

/** release asset triple → [dir under bin/, file name] */
const TARGETS = {
  "aarch64-apple-darwin": ["darwin-arm64", "mafold"],
  "x86_64-apple-darwin": ["darwin-x64", "mafold"],
  "x86_64-pc-windows-msvc": ["win32-x64", "mafold.exe"],
};

const args = new Set(process.argv.slice(2));
const wanted = Object.keys(TARGETS).filter((t) => (args.has("--mac") && t.endsWith("apple-darwin")) || (args.has("--win") && t.endsWith("windows-msvc")));
if (wanted.length === 0) {
  console.error("usage: fetch-cli.mjs --mac|--win [--check]");
  process.exit(2);
}

for (const triple of wanted) {
  const expected = lock.sha256[triple];
  if (!expected) throw new Error(`cli.lock.json has no sha256 for ${triple}`);
  const url = `https://github.com/${lock.repo}/releases/download/v${lock.version}/mafold-${triple}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== expected) throw new Error(`${triple}: sha256 ${got} does not match cli.lock.json ${expected}`);
  const [dir, name] = TARGETS[triple];
  const out = join(root, "bin", dir, name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  if (!name.endsWith(".exe")) chmodSync(out, 0o755);
  console.log(`✓ mafold ${lock.version} ${triple} → bin/${dir}/${name}`);
}

if (args.has("--check")) {
  const here = `${process.platform}-${process.arch}`;
  const entry = Object.values(TARGETS).find(([dir]) => dir === here);
  if (!entry) throw new Error(`no bundled cli for this machine (${here}) to check`);
  const exe = join(root, "bin", entry[0], entry[1]);
  let out = "";
  try {
    out = execFileSync(exe, ["status", "--json"], { encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    throw new Error(
      `mafold ${lock.version} cannot report its status to the shell (\`status --json\`): ${String(e.stderr || e.message).trim()}\n` +
        "Bump cli.lock.json to a cli release that has it.",
    );
  }
  const status = JSON.parse(out.trim().split("\n").pop());
  if (typeof status.supervisor !== "object") throw new Error(`unexpected status --json output: ${out}`);
  console.log(`✓ mafold ${lock.version} answers status --json`);
}
