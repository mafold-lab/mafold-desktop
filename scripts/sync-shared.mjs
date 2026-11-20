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
const SHARED = [
  ["../client-shared/desktopHost.ts", "src/shared/desktopHost.generated.ts"],
  // How a number reads — the tray's unread count, like every other surface.
  ["../client-shared/units.ts", "src/shared/units.generated.ts"],
  // The colour the app stands on — the window's background and the offline
  // page's, the same as the web app's own.
  ["../client-shared/appGround.ts", "src/shared/appGround.generated.ts"],
  // Where a reload lands — the hash the web app reads as a place, which a
  // restart into a new version brings back (src/main/relaunch.ts).
  ["../client-shared/reloadLanding.ts", "src/shared/reloadLanding.generated.ts"],
  // 加载画面的静止帧和正中那颗图标(内嵌成 data URI)—— 窗口开出来、网页还没到时
  // 盖在上面的那层(src/main/cover.ts)画的就是网页第一帧那一张。
  ["../client-shared/loadingFrame.ts", "src/shared/loadingFrame.generated.ts"],
  ["../client-shared/loadingIcon.ts", "src/shared/loadingIcon.generated.ts"],
];

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
