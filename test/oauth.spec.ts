import { describe, expect, it } from "vitest";

import { MAX_PENDING, OAUTH_TTL_MS, PendingAuth } from "../src/main/oauth";

const S = (n = 1) => `dsk_state-number-${n}`;

describe("PendingAuth", () => {
  it("delivers a result to the state that asked, once", async () => {
    const p = new PendingAuth();
    const { accepted, result } = p.begin(S(), 0);
    expect(accepted).toBe(true);
    expect(p.deliver(S(), { code: "c1" }, 1)).toBe(true);
    await expect(result).resolves.toEqual({ code: "c1" });
    expect(p.deliver(S(), { code: "again" }, 2)).toBe(false);
  });

  it("drops results for states it never issued", () => {
    const p = new PendingAuth();
    p.begin(S(1), 0);
    expect(p.deliver(S(2), { code: "x" }, 1)).toBe(false);
    expect(p.size).toBe(1);
  });

  it("refuses states without the desktop prefix, malformed ones and duplicates", async () => {
    const p = new PendingAuth();
    for (const bad of ["abc_not_desktop_state", "dsk_", "dsk_short", "dsk_has spaces in it", "dsk_" + "x".repeat(300)]) {
      const r = p.begin(bad, 0);
      expect(r.accepted, bad).toBe(false);
      await expect(r.result).resolves.toHaveProperty("error");
    }
    p.begin(S(), 0);
    expect(p.begin(S(), 0).accepted).toBe(false);
  });

  it("times out", async () => {
    const p = new PendingAuth();
    const { result } = p.begin(S(), 0);
    expect(p.deliver(S(), { code: "late" }, OAUTH_TTL_MS + 1)).toBe(false);
    await expect(result).resolves.toEqual({ error: "timed out" });

    const second = p.begin(S(2), 0);
    p.sweep(OAUTH_TTL_MS);
    await expect(second.result).resolves.toEqual({ error: "timed out" });
    expect(p.size).toBe(0);
  });

  it("lets the newest crowd out the oldest", async () => {
    const p = new PendingAuth();
    const first = p.begin(S(0), 0);
    for (let i = 1; i < MAX_PENDING; i++) p.begin(S(i), 0);
    p.begin(S(99), 0);
    await expect(first.result).resolves.toEqual({ error: "superseded" });
    expect(p.size).toBe(MAX_PENDING);
  });
});
