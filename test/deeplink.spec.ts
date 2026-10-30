import { describe, expect, it } from "vitest";

import { deepLinkInArgv, parseDeepLink } from "../src/main/deeplink";

const CONV = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("parseDeepLink", () => {
  it("reads an app hash", () => {
    expect(parseDeepLink(`mafold://app#${CONV}`)).toEqual({ kind: "app", hash: `#${CONV}` });
    expect(parseDeepLink("MAFOLD://app#garden")).toEqual({ kind: "app", hash: "#garden" });
  });
  it("refuses hashes that cannot be one", () => {
    expect(parseDeepLink("mafold://app")).toBeNull();
    expect(parseDeepLink("mafold://app#")).toBeNull();
    // URL 解析会把空白转成 %20;到了页面也什么都不是(是不是个地方由页面读 hash 时
    // 按 client-shared/reloadLanding.ts 的 landingFromHash 定,深链这里不判断)。
    expect(parseDeepLink("mafold://app#a b")).toEqual({ kind: "app", hash: "#a%20b" });
    expect(parseDeepLink(`mafold://app#${"x".repeat(600)}`)).toBeNull();
  });
  it("reads an OAuth hand-back", () => {
    expect(parseDeepLink("mafold://link?code=abc&state=dsk_123")).toEqual({ kind: "link", state: "dsk_123", code: "abc", error: undefined });
    expect(parseDeepLink("mafold://link?state=dsk_1&error=access_denied&error_description=no")).toEqual({
      kind: "link",
      state: "dsk_1",
      code: undefined,
      error: "access_denied: no",
    });
    expect(parseDeepLink("mafold://link?code=abc")).toBeNull();
  });
  it("ignores other schemes and hosts", () => {
    for (const raw of ["https://mafold.com/app#x", "mafold://evil#x", "mafoldx://app#x", "", "mafold:app#x"]) {
      expect(parseDeepLink(raw), raw).toBeNull();
    }
  });
});

describe("deepLinkInArgv", () => {
  it("finds the link a second instance was started with", () => {
    expect(deepLinkInArgv(["C:\\Mafold.exe", "--hidden", `mafold://app#${CONV}`])).toBe(`mafold://app#${CONV}`);
    expect(deepLinkInArgv(["/Applications/Mafold.app", "--x"])).toBeNull();
  });
});
