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
  out({ version: "0.9.999", exe: me, exe_canonical: me, supervisor: s.supervisor, accounts: s.accounts, daemons: [], harnesses: [{ id: "claude-code", available: true, version: "2.1.0" }], vault: s.vault });
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
} else if (args[0] === "account" && args[1] === "rm") {
  const s = read();
  s.accounts = s.accounts.filter((a) => a !== args[2]);
  write(s);
} else {
  process.stderr.write(`fake mafold: unknown command ${cmd}\n`);
  process.exit(2);
}
