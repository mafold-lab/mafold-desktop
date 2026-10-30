import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { accountChoice, accountLabel, KEYCHAIN_ACCESS_GROUP, TEAM_ID } from "../src/main/webauthn";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("accountChoice", () => {
  it("answers even when there is nothing to choose (Electron would hang otherwise)", () => {
    expect(accountChoice([])).toEqual({ cancel: true });
  });
  it("takes the first of one person's passkeys without asking", () => {
    expect(accountChoice([{ credentialId: "a", userHandle: "u1" }, { credentialId: "b", userHandle: "u1" }])).toEqual({ pick: "a" });
    expect(accountChoice([{ credentialId: "a" }])).toEqual({ pick: "a" });
  });
  it("asks when the passkeys belong to different accounts", () => {
    const two = [{ credentialId: "a", userHandle: "u1" }, { credentialId: "b", userHandle: "u2" }];
    expect(accountChoice(two)).toEqual({ ask: two });
  });
});

describe("accountLabel", () => {
  it("says who, from whatever the site stored", () => {
    expect(accountLabel({ credentialId: "a", name: "ada", displayName: "Ada Lovelace" })).toBe("Ada Lovelace (ada)");
    expect(accountLabel({ credentialId: "a", name: "ada", displayName: "ada" })).toBe("ada");
    expect(accountLabel({ credentialId: "a", displayName: "Ada" })).toBe("Ada");
    expect(accountLabel({ credentialId: "abcdefghijklmnop" })).toBe("abcdefghijkl");
  });
});

// The keychain group lives in four places that must agree, and a mismatch is
// silent until it isn't: a group the app doesn't claim leaves Touch ID off
// (the 0.1.1 bug), a claim the profile doesn't allow gets the app killed at
// launch. CI's release job checks the signed app; this checks the sources.
describe("passkey signing setup", () => {
  const builder = read("electron-builder.yml");
  const field = (k: string) => builder.match(new RegExp(`^\\s+${k}:\\s*(\\S+)\\s*$`, "m"))?.[1];
  const appId = builder.match(/^appId:\s*(\S+)/m)?.[1];

  it("asks Touch ID to store under the bundle's own group", () => {
    expect(appId).toBe("com.mafold.desktop");
    expect(KEYCHAIN_ACCESS_GROUP).toBe(`${TEAM_ID}.${appId}.webauthn`);
  });

  it("claims that group, with the app and team ids the profile names, on the app only", () => {
    expect(field("entitlements")).toBe("build/entitlements.mac.plist");
    expect(field("entitlementsInherit")).toBe("build/entitlements.mac.inherit.plist");
    const app = read("build/entitlements.mac.plist");
    expect(app).toContain(`<string>${KEYCHAIN_ACCESS_GROUP}</string>`);
    expect(app).toMatch(new RegExp(`<key>com.apple.application-identifier</key>\\s*<string>${TEAM_ID}\\.${appId}</string>`));
    expect(app).toMatch(new RegExp(`<key>com.apple.developer.team-identifier</key>\\s*<string>${TEAM_ID}</string>`));
    const helpers = read("build/entitlements.mac.inherit.plist");
    for (const restricted of ["keychain-access-groups", "com.apple.application-identifier", "com.apple.developer.team-identifier"]) {
      expect(helpers).not.toContain(restricted);
    }
    // Everything else the helpers had before still there.
    expect(helpers).toContain("com.apple.security.cs.allow-jit");
  });

  it("embeds a Developer ID profile that authorises it", () => {
    const path = field("provisioningProfile");
    expect(path).toBe("build/Mafold_Desktop_DeveloperID.provisionprofile");
    // CMS-signed, but the plist inside is plain text.
    const profile = readFileSync(join(__dirname, "..", path!)).toString("latin1");
    expect(profile).toMatch(new RegExp(`<key>com.apple.application-identifier</key>\\s*<string>${TEAM_ID}\\.${appId}</string>`));
    expect(profile).toMatch(new RegExp(`<key>keychain-access-groups</key>\\s*<array>\\s*<string>${TEAM_ID}\\.\\*</string>`));
    expect(profile).toMatch(/<key>ProvisionsAllDevices<\/key>\s*<true\/>/);
  });
});
