// The host contract lives once, in `client-shared/desktopHost.ts`, and is
// compiled here from a generated copy — the same arrangement mafold-web uses
// (mafold-web/scripts/sync-shared.mjs). The copy is never a second editable
// source.
//
// Outside the monorepo (the public mirror the release builds from) there is no
// `../client-shared`; the mirror job ships the generated copy instead, so a
// missing source with a present copy is fine — a missing both is not.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = [["../client-shared/desktopHost.ts", "src/shared/desktopHost.generated.ts"]];

for (const [from, to] of SHARED) {
  const source = resolve(root, from);
  const target = resolve(root, to);
  if (!existsSync(source)) {
    if (existsSync(target)) continue;
    throw new Error(`${from} is missing and there is no generated ${to} to fall back on`);
  }
  const content = `// GENERATED from ${from.replace(/^\.\.\//, "")} — DO NOT EDIT.\n` + readFileSync(source, "utf8");
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target) || readFileSync(target, "utf8") !== content) writeFileSync(target, content);
}
