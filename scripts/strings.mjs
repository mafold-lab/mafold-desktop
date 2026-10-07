// The shell's own words (menus, tray, notifications, the offline page, the
// confirmation dialogs) come from the one language pack every client uses:
// the `desktop.*` keys of `mafold-api/langpacks/*.json`. They are snapshotted
// into `static/strings.json` at build time because the shell has to speak
// before the page has loaded — and because a confirmation dialog must never
// take its wording from the page (`src/main/i18n.ts`).
//
// Outside the monorepo (the public mirror) the mirror job ships the snapshot.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packs = resolve(root, "../mafold-api/langpacks");
const out = resolve(root, "static/strings.json");
const PREFIX = "desktop.";

if (!existsSync(packs)) {
  if (existsSync(out)) process.exit(0);
  throw new Error("no ../mafold-api/langpacks and no static/strings.json to fall back on");
}

const result = {};
// Language packs only (`en.json`, `zh-Hans.json`) — not the dotfiles beside them.
for (const file of readdirSync(packs).filter((f) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*\.json$/.test(f)).sort()) {
  const lang = file.replace(/\.json$/, "");
  const pack = JSON.parse(readFileSync(resolve(packs, file), "utf8"));
  result[lang] = Object.fromEntries(Object.entries(pack).filter(([k]) => k.startsWith(PREFIX)).sort(([a], [b]) => a.localeCompare(b)));
}

// English is the reference: every other pack must carry every key it has.
const reference = Object.keys(result.en ?? {});
if (reference.length === 0) throw new Error(`no ${PREFIX}* keys in en.json`);
for (const [lang, strings] of Object.entries(result)) {
  const missing = reference.filter((k) => !(k in strings));
  if (missing.length) throw new Error(`${lang}.json is missing ${missing.join(", ")}`);
}

const content = JSON.stringify(result, null, 2) + "\n";
if (!existsSync(out) || readFileSync(out, "utf8") !== content) writeFileSync(out, content);
