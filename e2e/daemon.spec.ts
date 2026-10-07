// "Run bots on this computer", end to end against a fake mafold (fake-mafold.cjs)
// in a temp home: the shell installs it, signs it in through a device code the
// page approves, waits for the key, starts it — and stops it; and it leaves a
// supervisor that someone else set up strictly alone.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

type Host = {
  daemon: {
    status(): Promise<{ supervisor: string; accounts: string[]; vault: string; task: unknown; cli: { installed: boolean } }>;
    enable(u: string): Promise<Record<string, unknown>>;
    disable(u: string): Promise<{ ok: boolean; error?: string }>;
  };
};
const host = (l: Launched) => ({
  status: () => l.page.evaluate(() => (window as unknown as { mafoldHost: Host }).mafoldHost.daemon.status()),
  enable: (u: string) => l.page.evaluate((x) => (window as unknown as { mafoldHost: Host }).mafoldHost.daemon.enable(x), u),
  disable: (u: string) => l.page.evaluate((x) => (window as unknown as { mafoldHost: Host }).mafoldHost.daemon.disable(x), u),
});
const calls = (l: Launched) => {
  try {
    return readFileSync(`${l.dirs.fakeState}.calls`, "utf8").trim().split("\n");
  } catch {
    return [];
  }
};

let origins: Origins;
let l: Launched | null = null;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.afterEach(async () => {
  await l?.app.close();
  l = null;
});

test("install, sign in, get the key, start — then stop", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  const h = host(l);

  expect((await h.status()).cli.installed).toBe(false);
  const r = await h.enable("alice");
  expect(r).toEqual({ userCode: "FAKE-0001" });
  expect(existsSync(join(l.dirs.mafoldHome, "mafold"))).toBe(true);

  // What the page does with the code: approve it as the signed-in person.
  writeFileSync(`${l.dirs.fakeState}.approved`, "alice");

  await expect.poll(async () => (await h.status()).supervisor, { timeout: 20_000 }).toBe("running");
  const s = await h.status();
  expect(s.accounts).toEqual(["alice"]);
  expect(s.vault).toBe("cached");
  expect(s.task).toBeNull();
  expect(calls(l)).toEqual(expect.arrayContaining(["login --device-json --no-up", "connection unlock --json", "up"]));
  // The page heard about it as it happened.
  await expect
    .poll(() => l!.page.evaluate(() => (window as unknown as { __daemon: { supervisor: string }[] }).__daemon.map((x) => x.supervisor)))
    .toContain("running");

  expect(await h.disable("alice")).toEqual({ ok: true });
  expect(calls(l)).toContain("down");
  expect((await h.status()).supervisor).toBe("absent");
});

test("a supervisor someone set up from the command line is left alone", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  // An existing install (the cli is already in the home) whose service runs a dev build.
  const h = host(l);
  writeFileSync(
    l.dirs.fakeState,
    JSON.stringify({
      accounts: ["bob"],
      supervisor: { running: true, autostart: true, registered_exe: "/home/bob/dev/mafold/target/release/mafold", registered_exe_canonical: "/home/bob/dev/mafold/target/release/mafold", no_auto_update: true },
      vault: "cached",
    }),
  );
  await h.enable("bob"); // installs the cli into the temp home, then sees it is foreign
  expect((await h.status()).supervisor).toBe("foreign");
  expect(await h.enable("bob")).toEqual({ error: "foreign" });
  expect(await h.disable("bob")).toEqual({ ok: false, error: "foreign" });
  expect(calls(l).filter((c) => c === "up" || c === "down" || c.startsWith("login"))).toEqual([]);
});

test("a mafold too old to report its status is updated first", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  writeFileSync(l.dirs.fakeState, JSON.stringify({ old: true, accounts: ["alice"], supervisor: { running: false, autostart: false }, vault: "cached" }));
  // Installed by an earlier enable that was cancelled? No — install it the way
  // a person would have: the shell's first enable copies it in, sees it old,
  // updates it, and carries on (alice is already signed in here).
  const r = await host(l).enable("alice");
  expect(r).toEqual({ ready: true });
  expect(calls(l)).toContain("update");
  await expect.poll(async () => (await host(l!).status()).supervisor, { timeout: 20_000 }).toBe("running");
});

test("no in the native dialog means nothing happens", async () => {
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_TEST_CONFIRM: "no" });
  await l.page.waitForSelector("#h");
  expect(await host(l).enable("alice")).toEqual({ error: "cancelled" });
  expect(existsSync(join(l.dirs.mafoldHome, "mafold"))).toBe(false);
});

test("the page cannot pass anything but an account name", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  expect(await host(l).enable("alice; rm -rf ~")).toEqual({ error: "invalid account" });
  expect(calls(l)).toEqual([]);
});
