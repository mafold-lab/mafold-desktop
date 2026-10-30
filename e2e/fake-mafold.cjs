#!/usr/bin/env node
// A stand-in for mafold-cli in the e2e suite: the shell installs it into a temp
// home and drives it exactly as it would the real one. Its whole state is one
// JSON file (MAFOLD_FAKE_STATE); every call is appended to `<state>.calls`, so
// a test can assert what the shell did NOT run (no `up` on a foreign
// supervisor). It touches nothing else on the machine.
const fs = require("node:fs");

const statePath = process.env.MAFOLD_FAKE_STATE;
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { accounts: [], supervisor: { running: false, autostart: false, registered_exe: null, registered_exe_canonical: null, no_auto_update: null }, vault: "none" };
  }
};
const write = (s) => fs.writeFileSync(statePath, JSON.stringify(s));
const args = process.argv.slice(2);
fs.appendFileSync(`${statePath}.calls`, args.join(" ") + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const me = fs.realpathSync(process.argv[1]);

const cmd = args.join(" ");
// `old: true` in the state plays a mafold from before `status --json`.
if (read().old && args.includes("--json")) {
  process.stderr.write("error: unexpected argument '--json' found\n");
  process.exit(2);
}
if (cmd === "--version") {
  process.stdout.write("mafold 0.9.999\n");
} else if (cmd === "update") {
  const s = read();
  s.old = false;
  write(s);
} else if (cmd === "status --json") {
  const s = read();
  // `ours: true` plays a service registered to this very binary. An install
  // or a rollback that asked the supervisor to move: it has, once `moveAt`
  // passed (the replies it was writing are written).
  if (s.moveAt && Date.now() >= s.moveAt) {
    s.supervisor.version = s.version;
    delete s.moveAt;
    write(s);
  }
  const supervisor = s.supervisor?.ours ? { ...s.supervisor, ours: undefined, registered_exe: me, registered_exe_canonical: me } : s.supervisor;
  out({ version: s.version ?? "0.9.999", exe: me, exe_canonical: me, device_id: "dev-fake", supervisor, accounts: s.accounts, daemons: s.daemons ?? [], harnesses: [{ id: "claude-code", available: true, version: "2.1.0" }], vault: s.vault, update: s.update });
} else if (args[0] === "update" && args.includes("--json") && read().update) {
  // mafold-cli C8, the real one's way: `--channel` switched first, then
  // `--auto-update` set, a check (`--check`), or the release in `offer`
  // installed — the version left kept as the backup, and the supervisor asked
  // to move onto it.
  const s = read();
  const said = (o) => out({ ok: true, version: s.version, channel: s.update.channel, auto_update: s.update.auto_update_setting, ...o });
  const at = (flag) => args[args.indexOf(flag) + 1];
  if (args.includes("--channel")) s.update.channel = at("--channel");
  if (args.includes("--auto-update")) {
    s.update.auto_update_setting = at("--auto-update") === "on";
    s.update.auto_update = s.update.auto_update_setting;
    write(s);
    said({ code: "set" });
  } else if (args.includes("--check")) {
    s.update.checked_at = Math.floor(Date.now() / 1000);
    s.update.available = s.offer && s.offer !== s.version ? s.offer : null;
    write(s);
    said({ code: s.update.available ? "available" : "current", latest: s.offer ?? s.version });
  } else if (s.offer && s.offer !== s.version) {
    s.backup = s.version;
    s.version = s.offer;
    const moving = !!s.supervisor?.running;
    if (moving) s.moveAt = Date.now() + 1500;
    write(s);
    said({ code: "updated", latest: s.version, restart: "…", moving });
  } else {
    said({ code: "current" });
  }
} else if (args[0] === "rollback" && args.includes("--json")) {
  // mafold-cli C9: back to `backup`, the version left skipped.
  const s = read();
  const base = { from: s.version, to: s.backup ?? null, sticks: !!s.backup };
  if (!s.backup) {
    out({ ok: false, code: "no_backup", ...base });
    process.exit(args.includes("--check") ? 0 : 1);
  }
  if (args.includes("--check")) {
    out({ ok: true, code: "possible", ...base });
  } else {
    s.update.skipped = { version: s.version, at: Math.floor(Date.now() / 1000) };
    s.version = s.backup;
    delete s.backup;
    const moving = !!s.supervisor?.running;
    if (moving) s.moveAt = Date.now() + 1500;
    write(s);
    out({ ok: true, code: "rolled_back", ...base, restart: "…", moving });
  }
} else if (args[0] === "restart" && args[2] === "--json") {
  // `restart` the real one's way: a new pid for the bot, said as JSON. With
  // `restartSaysOnly` in the state it says so without doing it — a restart
  // the shell must not take on the cli's word alone.
  const s = read();
  const bot = (s.daemons ?? []).find((d) => d.name === args[1]);
  if (!bot) {
    out({ ok: false, code: "unknown_bot", name: args[1], interrupted: 0 });
    process.exit(1);
  }
  const old = bot.pid;
  const next = old + 1;
  if (!s.restartSaysOnly) {
    bot.pid = next;
    write(s);
  }
  out({ ok: true, code: "restarted", name: bot.name, old_pid: old, new_pid: next, interrupted: 1 });
} else if (args[0] === "up" && args[1] === "--adopt" && args.includes("--json")) {
  // mafold-cli C10, the real one's way: `--check` says why the service isn't
  // this binary's and what moving it would restart; without it, it moves it —
  // registered to this binary without the flag, every bot a new process, and
  // updates as the machine setting says.
  const s = read();
  const sup = s.supervisor ?? {};
  const registered = sup.ours ? me : (sup.registered_exe_canonical ?? sup.registered_exe ?? null);
  const reasons = [];
  if (registered && registered !== me) reasons.push("elsewhere");
  if (registered && sup.no_auto_update === true) reasons.push("update_flag");
  if (!registered && sup.running) reasons.push("by_hand");
  const setting = s.update?.auto_update_setting ?? true;
  const bots = () => (s.daemons ?? []).map((d) => ({ name: d.name, pid: d.running ? d.pid : null, busy: !!d.busy }));
  const said = { exe: me, reasons, registered_exe: registered, service_base: "https://api.mafold.ai", was_running: sup.running ? 1 : null, pid: null, cut: [], auto_update: setting };
  if (args.includes("--check")) {
    out({ ok: true, code: reasons.length ? "adoptable" : registered || sup.running ? "managed" : "not_set_up", ...said, bots: bots() });
  } else {
    s.supervisor = { running: true, autostart: true, registered_exe: me, registered_exe_canonical: me, no_auto_update: false, version: s.version ?? "0.9.999" };
    for (const d of s.daemons ?? []) {
      d.pid += 1000;
      d.running = true;
      d.busy = false;
    }
    if (s.update) s.update.auto_update = setting;
    write(s);
    out({ ok: true, code: "adopted", ...said, pid: 2, bots: bots() });
  }
} else if (cmd === "login --device-json --no-up") {
  process.stdout.write("a note for people\n");
  out({ event: "code", user_code: "FAKE-0001", verify_url: "https://example.invalid/login/device?code=FAKE-0001", expires_in: 600 });
  const deadline = Date.now() + 20000;
  const tick = () => {
    const approved = `${statePath}.approved`;
    if (fs.existsSync(approved)) {
      const user = fs.readFileSync(approved, "utf8").trim();
      const s = read();
      if (!s.accounts.includes(user)) s.accounts.push(user);
      s.vault = "device";
      write(s);
      out({ event: "approved", username: user });
      process.exit(0);
    }
    if (Date.now() > deadline) {
      out({ event: "expired" });
      process.exit(1);
    }
    setTimeout(tick, 200);
  };
  tick();
} else if (cmd === "connection unlock --json") {
  const s = read();
  s.vault = "cached";
  write(s);
  out({ state: "unlocked", key_id: "k1", fingerprint: "ff" });
} else if (cmd === "up") {
  const s = read();
  s.supervisor = { running: true, autostart: true, registered_exe: me, registered_exe_canonical: me, no_auto_update: false };
  write(s);
} else if (cmd === "down") {
  const s = read();
  s.supervisor = { running: false, autostart: false, registered_exe: null, registered_exe_canonical: null, no_auto_update: null };
  write(s);
} else if (args[0] === "logs" && args.includes("--json")) {
  // `logs [bot] -n <lines> [-f] --json`, the real one's way: `open`, the last
  // lines of `logs[bot]` (or `logs.supervisor`) from the state, and with -f
  // `flood` long lines at once, then one every 50 ms until it is stopped. A
  // follow writes its pid to `<state>.follow` for the test to look for.
  const s = read();
  const bot = args[1] && !args[1].startsWith("-") ? args[1] : null;
  const n = Number(args[args.indexOf("-n") + 1]) || 40;
  const log = (s.logs ?? {})[bot ?? "supervisor"];
  if (!log) {
    process.stderr.write(bot ? `Error: no log for \`${bot}\` (looked at /fake/${bot})\n` : "Error: no supervisor log yet (looked at /fake/supervisor)\n");
    process.exit(1);
  }
  out({ type: "open", source: bot ? "bot" : "supervisor", name: bot, path: `/fake/${bot ?? "supervisor"}` });
  for (const text of log.slice(-n)) out({ type: "line", text });
  if (args.includes("-f")) {
    fs.writeFileSync(`${statePath}.follow`, String(process.pid));
    for (let i = 0; i < (s.flood ?? 0); i++) out({ type: "line", text: `flood ${i} ${"f".repeat(1000)}` });
    let i = 0;
    setInterval(() => out({ type: "line", text: `tick ${i++}` }), 50);
  }
} else if (args[0] === "diagnose" && args.includes("--json")) {
  // `diagnose --out <path> --json`: a small file where it was told, and what it wrote.
  const where = args[args.indexOf("--out") + 1];
  const text = JSON.stringify({ diagnose: 1, masked: 2 });
  fs.writeFileSync(where, text);
  out({ path: where, bytes: Buffer.byteLength(text), masked: 2 });
} else if (args[0] === "account" && args[1] === "rm") {
  const s = read();
  s.accounts = s.accounts.filter((a) => a !== args[2]);
  write(s);
} else {
  process.stderr.write(`fake mafold: unknown command ${cmd}\n`);
  process.exit(2);
}
