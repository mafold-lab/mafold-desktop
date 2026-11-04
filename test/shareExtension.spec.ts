import { describe, expect, it, vi } from "vitest";

import { parseElection, SHARE_EXTENSION_ID, switchOnOnce } from "../src/main/shareExtension";

const line = (mark: string) => `${mark}    ${SHARE_EXTENSION_ID}(0.1.5)\n`;

describe("parseElection", () => {
  it("reads pluginkit's mark", () => {
    expect(parseElection(line("+"))).toBe("on");
    expect(parseElection(line("-"))).toBe("off");
    expect(parseElection(line(" "))).toBe("undecided");
  });

  it("no line for this extension: macOS hasn't found it", () => {
    expect(parseElection("")).toBe("missing");
    expect(parseElection(line("+").replace(SHARE_EXTENSION_ID, "com.other.share"))).toBe("missing");
  });

  it("leaves a mark it doesn't know alone", () => {
    expect(parseElection(line("!"))).toBe("off");
  });

  it("does not take a longer id for ours", () => {
    expect(parseElection(`+    ${SHARE_EXTENSION_ID}.extra(1)\n`)).toBe("missing");
  });
});

/** pluginkit with the marks each `-m` answers, in order; the last one repeats. */
function kit(...marks: string[]) {
  const calls: string[][] = [];
  const pluginkit = async (args: string[]) => {
    calls.push(args);
    if (args[0] !== "-m") return "";
    return marks.length > 1 ? (marks.shift() as string) : marks[0];
  };
  return { calls, pluginkit, sleep: vi.fn(async () => {}) };
}

const use = ["-e", "use", "-i", SHARE_EXTENSION_ID];

describe("switchOnOnce", () => {
  it("switches on an extension nobody chose for", async () => {
    const k = kit(line(" "), line("+"));
    await expect(switchOnOnce("/A/M.appex", k)).resolves.toBe(true);
    expect(k.calls[0]).toEqual(["-a", "/A/M.appex"]);
    expect(k.calls).toContainEqual(use);
  });

  it("never overrides a person's off", async () => {
    const k = kit(line("-"));
    await expect(switchOnOnce("/A/M.appex", k)).resolves.toBe(true);
    expect(k.calls).not.toContainEqual(use);
  });

  it("already on: nothing to do", async () => {
    const k = kit(line("+"));
    await expect(switchOnOnce("/A/M.appex", k)).resolves.toBe(true);
    expect(k.calls).not.toContainEqual(use);
  });

  it("waits for macOS to find a fresh install", async () => {
    const k = kit("", "", line(" "), line("+"));
    await expect(switchOnOnce("/A/M.appex", k)).resolves.toBe(true);
    expect(k.sleep).toHaveBeenCalledTimes(2);
    expect(k.calls).toContainEqual(use);
  });

  it("gives this launch up when macOS never finds it", async () => {
    const k = kit("");
    await expect(switchOnOnce("/A/M.appex", k)).resolves.toBe(false);
    expect(k.sleep).toHaveBeenCalledTimes(4);
    expect(k.calls).not.toContainEqual(use);
  });

  it("a switch that didn't take is tried again next launch", async () => {
    const k = kit(line(" "));
    await expect(switchOnOnce("/A/M.appex", k)).resolves.toBe(false);
  });
});
