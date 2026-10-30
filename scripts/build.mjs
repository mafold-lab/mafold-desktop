// Bundle the main process and the preload. The preload MUST be a single file:
// a sandboxed preload can require `electron` and nothing local, so the shared
// contract is bundled into it. The main process is bundled too, so the
// packaged app carries one file instead of a dist tree.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "electron-updater"],
  logLevel: "warning",
  legalComments: "none",
};

await build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js" });
await build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.js" });
