// "Run bots on this computer", end to end against a fake mafold (fake-mafold.cjs)
// in a temp home: the shell installs it, signs it in through a device code the
// page approves, waits for the key, starts it — and stops it; and it leaves a
// supervisor that someone else set up strictly alone.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const s = await h.status();
  expect(s.supervisor).toBe("foreign");
  // Why, for the page to say (activity center D5): another install's binary, set up with updates off.
  expect((s as unknown as { foreign?: string[] }).foreign).toEqual(["elsewhere", "update_flag"]);
  expect(await h.enable("bob")).toEqual({ error: "foreign" });
  expect(await h.disable("bob")).toEqual({ ok: false, error: "foreign" });
  expect(await cliUpdate(l).updateCli()).toEqual({ ok: false, error: "foreign" });
  expect(calls(l).filter((c) => c === "up" || c === "down" || c.startsWith("login") || c.startsWith("update") || c.startsWith("rollback"))).toEqual([]);
});

type CliUpdateHost = {
  caps: string[];
  daemon: {
    checkUpdate(): Promise<unknown>;
    updateCli(): Promise<unknown>;
    setAutoUpdate(on: unknown): Promise<unknown>;
    setChannel(c: unknown): Promise<unknown>;
    rollbackCheck(): Promise<unknown>;
    rollback(): Promise<unknown>;
  };
};
/** The page calling `daemon.<method>(arg?)` of the `cli-update` capability. */
const cliUpdate = (l: Launched) => {
  const call = (method: keyof CliUpdateHost["daemon"], arg?: unknown) =>
    l.page.evaluate(
      ([m, a]) => {
        const d = (window as unknown as { mafoldHost: CliUpdateHost }).mafoldHost.daemon;
        return a === undefined ? (d[m] as () => Promise<unknown>)() : (d[m] as (x: unknown) => Promise<unknown>)(a);
      },
      [method, arg] as const,
    );
  return {
    checkUpdate: () => call("checkUpdate"),
    updateCli: () => call("updateCli"),
    setAutoUpdate: (on: unknown) => call("setAutoUpdate", on),
    setChannel: (c: unknown) => call("setChannel", c),
    rollbackCheck: () => call("rollbackCheck"),
    rollback: () => call("rollback"),
  };
};

/** A computer whose service is the shell's own, mafold 0.9.151 on it and
 *  0.9.152 on offer — after the shell installed its cli into the temp home
 *  (an `enable` that stops at a supervisor started by hand, which runs no `up`). */
const versioned = async (l: Launched) => {
  writeFileSync(l.dirs.fakeState, JSON.stringify({ accounts: ["alice"], supervisor: { running: true }, vault: "cached" }));
  expect(await host(l).enable("alice")).toEqual({ error: "foreign" });
  writeFileSync(
    l.dirs.fakeState,
    JSON.stringify({
      accounts: ["alice"],
      supervisor: { running: true, autostart: true, ours: true, no_auto_update: false, version: "0.9.151" },
      vault: "cached",
      version: "0.9.151",
      offer: "0.9.152",
      update: { channel: "stable", auto_update: true, auto_update_setting: true, checked_at: null, available: null, failed: null, skipped: null },
    }),
  );
};

test("mafold-cli's own updates: checked, installed and run, set, and rolled back after asking", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  expect(await l.page.evaluate(() => (window as unknown as { mafoldHost: CliUpdateHost }).mafoldHost.caps.includes("cli-update"))).toBe(true);
  await versioned(l);
  const u = cliUpdate(l);
  expect((await host(l).status()).supervisor).toBe("running");

  expect(await u.checkUpdate()).toMatchObject({ ok: true, latest: "0.9.152", update: { channel: "stable", available: "0.9.152" } });

  // Off as a setting: the computer stays the shell's (no `--no-auto-update`).
  expect(await u.setAutoUpdate(false)).toMatchObject({ ok: true, update: { autoUpdate: false, autoUpdateSetting: false } });
  expect((await host(l).status()).supervisor).toBe("running");
  expect(await u.setAutoUpdate("off")).toEqual({ ok: false, error: "refused" });
  expect(await u.setChannel("dev")).toMatchObject({ ok: true, update: { channel: "dev" } });
  expect(await u.setChannel("beta")).toEqual({ ok: false, error: "refused" });
  expect(await u.setChannel("stable")).toMatchObject({ ok: true, update: { channel: "stable" } });

  // Installed, then counted once the supervisor came back on it.
  expect(await u.updateCli()).toEqual({ ok: true, version: "0.9.152", updated: true, supervisor: "on_it" });
  expect(await host(l).status()).toMatchObject({ cli: { version: "0.9.152", running: "0.9.152" } });

  // Back to 0.9.151 (the native dialog answers yes here), 0.9.152 skipped.
  expect(await u.rollbackCheck()).toEqual({ ok: true, from: "0.9.152", to: "0.9.151" });
  expect(await u.rollback()).toEqual({ ok: true, version: "0.9.151", updated: true, supervisor: "on_it" });
  expect(await host(l).status()).toMatchObject({ cli: { version: "0.9.151", running: "0.9.151" }, update: { skipped: { version: "0.9.152" } } });
  // Nothing earlier kept now: nothing to offer.
  expect(await u.rollbackCheck()).toEqual({ ok: false, error: "no_backup" });

  expect(calls(l).filter((c) => c.startsWith("update") || c.startsWith("rollback"))).toEqual([
    "update --check --json",
    "update --auto-update off --json",
    "update --channel dev --check --json",
    "update --channel stable --check --json",
    "update --json",
    "rollback --check --json",
    // the rollback: asked before the dialog, and again after it
    "rollback --check --json",
    "rollback --check --json",
    "rollback --json",
    "rollback --check --json",
  ]);
});

test("no in the rollback dialog means nothing is rolled back", async () => {
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_TEST_CONFIRM: "no" });
  await l.page.waitForSelector("#h");
  // The dialog says no to `enable` too: the cli goes in the way a person's own install would.
  writeFileSync(
    l.dirs.fakeState,
    JSON.stringify({
      accounts: ["alice"],
      supervisor: { running: true, autostart: true, ours: true, version: "0.9.152" },
      vault: "cached",
      version: "0.9.152",
      backup: "0.9.151",
      update: { channel: "stable", auto_update: true, auto_update_setting: true, skipped: null },
    }),
  );
  const exe = join(l.dirs.mafoldHome, process.platform === "win32" ? "mafold.exe" : "mafold");
  mkdirSync(l.dirs.mafoldHome, { recursive: true });
  copyFileSync(join(__dirname, "fake-mafold.cjs"), exe);
  chmodSync(exe, 0o755);
  const u = cliUpdate(l);
  expect(await u.rollbackCheck()).toEqual({ ok: true, from: "0.9.152", to: "0.9.151" });
  expect(await u.rollback()).toEqual({ ok: false, error: "cancelled" });
  expect(calls(l).filter((c) => c.startsWith("rollback"))).toEqual(["rollback --check --json", "rollback --check --json"]);
  expect((await host(l).status()).cli.installed).toBe(true);
  expect(JSON.parse(readFileSync(l.dirs.fakeState, "utf8")).version).toBe("0.9.152");
});

type AdoptHost = { caps: string[]; daemon: { adoptCheck(): Promise<unknown>; adopt(): Promise<unknown> } };
/** The page calling the `adopt` capability. */
const adopting = (l: Launched) => ({
  check: () => l.page.evaluate(() => (window as unknown as { mafoldHost: AdoptHost }).mafoldHost.daemon.adoptCheck()),
  adopt: () => l.page.evaluate(() => (window as unknown as { mafoldHost: AdoptHost }).mafoldHost.daemon.adopt()),
});
const DEV_BUILD = "/home/bob/dev/mafold/target/release/mafold";
/** Bob's bot, run by a dev build's service set up with `--no-auto-update`. */
const devBuildComputer = {
  accounts: ["bob"],
  supervisor: { running: true, autostart: true, registered_exe: DEV_BUILD, registered_exe_canonical: DEV_BUILD, no_auto_update: true },
  daemons: [{ name: "bob:cc", running: true, pid: 4100 }],
  vault: "cached",
  update: { channel: "stable", auto_update: false, auto_update_setting: true, checked_at: null, available: null, failed: null, skipped: null },
};
const ADOPT_CALLS = (c: string) => c.startsWith("up");

test("a computer run from the command line is handed to Mafold after asking — and is the shell's from then on", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  expect(await l.page.evaluate(() => (window as unknown as { mafoldHost: AdoptHost }).mafoldHost.caps.includes("adopt"))).toBe(true);
  const h = host(l);
  writeFileSync(l.dirs.fakeState, JSON.stringify(devBuildComputer));
  await h.enable("bob"); // installs the cli into the temp home, then sees it is foreign
  expect((await h.status()).supervisor).toBe("foreign");
  const a = adopting(l);
  expect(await a.check()).toEqual({ ok: true, state: "adoptable", reasons: ["elsewhere", "update_flag"], bots: ["bob:cc"], busy: [], autoUpdate: true });
  // The native dialog answers yes here.
  expect(await a.adopt()).toEqual({ ok: true, adopted: true, bots: ["bob:cc"], cut: [], autoUpdate: true });
  const s = (await h.status()) as Awaited<ReturnType<ReturnType<typeof host>["status"]>> & { foreign?: string[] };
  expect(s.supervisor).toBe("running");
  expect(s.foreign).toBeUndefined();
  // Checked for the page, before the dialog and after it; then moved, once.
  expect(calls(l).filter(ADOPT_CALLS)).toEqual(["up --adopt --check --json", "up --adopt --check --json", "up --adopt --check --json", "up --adopt --json"]);
  // Nothing to hand over now.
  expect(await a.check()).toMatchObject({ ok: true, state: "managed" });
  expect(await a.adopt()).toEqual({ ok: true, adopted: false, bots: [], cut: [], autoUpdate: true });
  expect(calls(l).filter((c) => c === "up --adopt --json")).toHaveLength(1);
});

test("no in the hand-over dialog means nothing moves", async () => {
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_TEST_CONFIRM: "no" });
  await l.page.waitForSelector("#h");
  writeFileSync(l.dirs.fakeState, JSON.stringify(devBuildComputer));
  // The dialog says no to `enable` too: the cli goes in the way a person's own install would.
  const exe = join(l.dirs.mafoldHome, process.platform === "win32" ? "mafold.exe" : "mafold");
  mkdirSync(l.dirs.mafoldHome, { recursive: true });
  copyFileSync(join(__dirname, "fake-mafold.cjs"), exe);
  chmodSync(exe, 0o755);
  expect(await adopting(l).adopt()).toEqual({ ok: false, error: "cancelled" });
  expect(calls(l).filter(ADOPT_CALLS)).toEqual(["up --adopt --check --json"]);
  expect(JSON.parse(readFileSync(l.dirs.fakeState, "utf8")).supervisor.registered_exe).toBe(DEV_BUILD);
  expect((await host(l).status()).supervisor).toBe("foreign");
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

test("a bot is restarted, and the shell reads its new process back itself", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  const bot = { name: "alice:helper", harness: "claude-code", running: true, busy: true, pid: 4100 };
  writeFileSync(
    l.dirs.fakeState,
    JSON.stringify({ accounts: ["alice"], supervisor: { running: true, autostart: true }, vault: "cached", daemons: [bot] }),
  );
  expect(await l.page.evaluate(() => (window as unknown as { mafoldHost: { caps: string[] } }).mafoldHost.caps.includes("bot-restart"))).toBe(true);
  await host(l).enable("alice"); // installs the cli into the temp home
  const s = await host(l).status();
  expect((s as unknown as { deviceId?: string }).deviceId).toBe("dev-fake");
  const restart = (name: string) =>
    l!.page.evaluate((n) => (window as unknown as { mafoldHost: { daemon: { restart(n: string): Promise<unknown> } } }).mafoldHost.daemon.restart(n), name);

  expect(await restart("alice:helper")).toEqual({ ok: true, oldPid: 4100, newPid: 4101, interrupted: 1 });
  expect(calls(l)).toContain("restart alice:helper --json");

  // Asked again while it is under way (the card opened anew, a second
  // window): the same restart's outcome, and the cli runs once.
  const both = await l.page.evaluate((n) => {
    const d = (window as unknown as { mafoldHost: { daemon: { restart(n: string): Promise<unknown> } } }).mafoldHost.daemon;
    return Promise.all([d.restart(n), d.restart(n)]);
  }, "alice:helper");
  expect(both).toEqual([
    { ok: true, oldPid: 4101, newPid: 4102, interrupted: 1 },
    { ok: true, oldPid: 4101, newPid: 4102, interrupted: 1 },
  ]);

  // The cli's word alone isn't enough: the shell reads the bot back itself.
  writeFileSync(l.dirs.fakeState, JSON.stringify({ ...JSON.parse(readFileSync(l.dirs.fakeState, "utf8")), restartSaysOnly: true }));
  expect(await restart("alice:helper")).toMatchObject({ ok: false, error: "unverified" });

  // Only a bot configured here, and only a name.
  expect(await restart("alice:nobody")).toEqual({ ok: false, error: "unknown_bot" });
  expect(await restart("alice:helper; rm -rf ~")).toEqual({ ok: false, error: "refused" });
  expect(calls(l).filter((c) => c.startsWith("restart"))).toEqual(Array(3).fill("restart alice:helper --json"));
});

type LogHost = {
  caps: string[];
  daemon: {
    logs(u: string, bot: string | null, n: number): Promise<unknown>;
    followLogs(u: string, bot: string | null, n: number, cb: (f: { lines?: string[]; skipped?: number; end?: string }) => void): () => void;
    diagnose(): Promise<unknown>;
  };
};
type Seen = { at: number; size: number; f: { lines?: string[]; skipped?: number; end?: string } };

/** Start following in the page; what arrives collects in `window.__frames`. */
const follow = (l: Launched, bot: string | null) =>
  l.page.evaluate((b) => {
    const w = window as unknown as { mafoldHost: LogHost; __frames: Seen[]; __stop: () => void };
    w.__frames = [];
    w.__stop = w.mafoldHost.daemon.followLogs("alice", b, 3, (f) => w.__frames.push({ at: performance.now(), size: JSON.stringify(f).length, f }));
  }, bot);
const frames = (l: Launched) => l.page.evaluate(() => (window as unknown as { __frames: Seen[] }).__frames);
const followPid = (l: Launched) => Number(readFileSync(`${l.dirs.fakeState}.follow`, "utf8"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const withLogs = (l: Launched, extra: object = {}) =>
  writeFileSync(
    l.dirs.fakeState,
    JSON.stringify({
      accounts: ["alice"],
      supervisor: { running: true, autostart: true },
      vault: "cached",
      daemons: [
        { name: "alice:helper", harness: "claude-code", running: true, busy: false, pid: 4100 },
        { name: "bob:helper", harness: "claude-code", running: true, busy: false, pid: 5100 },
      ],
      logs: { "alice:helper": ["one", "two", "three"], "bob:helper": ["bob's"], supervisor: ["up"] },
      ...extra,
    }),
  );

test("a log is read, and followed at most four frames a second, 64 KB each — until the window closes", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  withLogs(l, { flood: 2000 });
  expect(await l.page.evaluate(() => (window as unknown as { mafoldHost: LogHost }).mafoldHost.caps.includes("logs"))).toBe(true);
  await host(l).enable("alice"); // installs the cli into the temp home
  const read = (bot: string | null, n: number) =>
    l!.page.evaluate(([b, k]) => (window as unknown as { mafoldHost: LogHost }).mafoldHost.daemon.logs("alice", b, k), [bot, n] as const);

  expect(await read("alice:helper", 2)).toEqual({ ok: true, lines: ["two", "three"] });
  expect(await read(null, 10)).toEqual({ ok: true, lines: ["up"] });
  // Someone else's bot: turned away before the cli is asked.
  expect(await read("bob:helper", 2)).toEqual({ ok: false, error: "not_yours" });
  expect(calls(l).filter((c) => c.startsWith("logs"))).toEqual(["logs alice:helper -n 2 --json", "logs -n 10 --json"]);

  // Following: the last lines, a flood of 2 MB at once, then a line every 50 ms.
  const since = await l.page.evaluate(() => performance.now());
  await follow(l, "alice:helper");
  await expect.poll(async () => (await frames(l!)).some((s) => s.f.lines?.some((x) => x.startsWith("tick "))), { timeout: 15_000 }).toBe(true);
  await l.page.waitForTimeout(1500);
  const seen = await frames(l);
  const until = await l.page.evaluate(() => performance.now());
  // Each frame within 64 KB (and its tag), the flood's oldest lines dropped and counted …
  expect(Math.max(...seen.map((s) => s.size))).toBeLessThanOrEqual(64 * 1024 + 100);
  expect(seen.some((s) => (s.f.skipped ?? 0) > 0)).toBe(true);
  expect(seen.flatMap((s) => s.f.lines ?? [])).toContain(`flood 1999 ${"f".repeat(1000)}`);
  // … at most four a second, give or take the first.
  expect(seen.length).toBeLessThanOrEqual(Math.ceil((until - since) / 250) + 2);

  // Closing the window (to the tray) ends it: the cli is stopped, and the page heard why.
  const pid = followPid(l);
  expect(alive(pid)).toBe(true);
  // The main window (its page is a view in it — window.ts): closed, so to the tray.
  await l.app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.close());
  await expect.poll(async () => (await frames(l!)).at(-1)?.f.end).toBe("closed");
  await expect.poll(() => alive(pid)).toBe(false);
});

test("a follow ends when the page stops it, or goes", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  withLogs(l);
  await host(l).enable("alice");

  await follow(l, null);
  await expect.poll(async () => (await frames(l!)).some((s) => s.f.lines?.includes("up"))).toBe(true);
  const first = followPid(l);
  await l.page.evaluate(() => (window as unknown as { __stop: () => void }).__stop());
  await expect.poll(() => alive(first)).toBe(false);

  await follow(l, "alice:helper");
  await expect.poll(async () => (await frames(l!)).some((s) => s.f.lines?.includes("three"))).toBe(true);
  const second = followPid(l);
  expect(second).not.toBe(first);
  await l.page.reload();
  await l.page.waitForSelector("#h");
  await expect.poll(() => alive(second)).toBe(false);

  // A log that isn't there: said as the follow's end.
  withLogs(l, { logs: {} });
  await follow(l, "alice:helper");
  await expect.poll(async () => (await frames(l!)).at(-1)?.f.end).toBe("no_log");
});

test("a diagnostics file goes where the save dialog says, and is read back there", async () => {
  const where = join(mkdtempSync(join(tmpdir(), "mafold-diag-")), "picked.json");
  l = await launch(origins.web, origins.api, { MAFOLD_DESKTOP_TEST_SAVE_AS: where });
  await l.page.waitForSelector("#h");
  withLogs(l);
  await host(l).enable("alice");
  const r = await l.page.evaluate(() => (window as unknown as { mafoldHost: LogHost }).mafoldHost.daemon.diagnose());
  expect(r).toEqual({ ok: true, name: "picked.json", bytes: readFileSync(where).length, masked: 2 });
  expect(calls(l)).toContain(`diagnose --out ${where} --json`);
});

test("the page cannot pass anything but an account name", async () => {
  l = await launch(origins.web, origins.api);
  await l.page.waitForSelector("#h");
  expect(await host(l).enable("alice; rm -rf ~")).toEqual({ error: "invalid account" });
  expect(calls(l)).toEqual([]);
});
