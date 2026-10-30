import { defineConfig } from "@playwright/test";

// The e2e suite launches the real shell (Electron) against local fixture
// servers standing in for the web and api origins (e2e/fixtures.ts). It runs in
// CI under xvfb (.github/workflows/desktop-tests.yml); it is not meant for the
// developer's own desktop session.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
});
