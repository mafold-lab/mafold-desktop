import { defineConfig } from "vitest/config";

// Unit tests cover the pure modules (navigation policy, deep links, the OAuth
// pending table, the badge bitmap, …) in plain node — no Electron. Anything
// that needs a real window is an e2e test under `e2e/` (Playwright `_electron`).
export default defineConfig({
  test: { include: ["test/**/*.spec.ts"], environment: "node" },
});
