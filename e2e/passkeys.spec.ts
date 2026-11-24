import { generateKeyPairSync } from "node:crypto";

import { expect, test } from "@playwright/test";

import { launch, startOrigins, type Launched, type Origins } from "./fixtures";

// The shell's half of passkeys that runs anywhere: when one sign-in matches
// passkeys of several accounts, Electron asks the session which one — and with
// nobody listening it cancels the request. A DevTools virtual authenticator
// stands in for Touch ID (which needs a signed build and a finger); the
// account question is the same.
//
// WebAuthn refuses an IP address as a relying party, so the page loads from
// `localhost` (same fixture server): a secure context with a valid RP ID.

let origins: Origins;
let l: Launched;

test.beforeAll(async () => {
  origins = await startOrigins();
});
test.afterAll(async () => {
  await origins.close();
});
test.beforeEach(async () => {
  l = await launch(origins.web.replace("127.0.0.1", "localhost"), origins.api);
  await l.page.waitForSelector("#h");
  // Answer the native picker from the test: pick the button containing
  // `__answer`, or cancel. Records what was asked.
  await l.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __asked: string[][]; __answer: string | null };
    g.__asked = [];
    g.__answer = null;
    const fake = async (...args: unknown[]) => {
      const o = (args.length > 1 ? args[1] : args[0]) as { buttons: string[]; cancelId: number };
      g.__asked.push(o.buttons);
      const i = g.__answer == null ? -1 : o.buttons.findIndex((b) => b.includes(g.__answer!));
      return { response: i >= 0 ? i : o.cancelId, checkboxChecked: false };
    };
    (dialog as unknown as { showMessageBox: typeof fake }).showMessageBox = fake;
  });
});
test.afterEach(async () => {
  await l.app.close();
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const b64url = (s: string) => Buffer.from(s).toString("base64url");

/** A virtual platform authenticator holding resident passkeys for `localhost`. */
async function passkeys(creds: { id: string; user: string; name: string }[]) {
  const cdp = await l.page.context().newCDPSession(l.page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  for (const c of creds) {
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "der" });
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: b64(c.id),
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: key.toString("base64"),
        userHandle: b64(c.user),
        userName: c.name,
        userDisplayName: c.name,
        signCount: 0,
      },
    });
  }
}

/** A usernameless sign-in, the kind that can match several accounts. */
const signIn = () =>
  l.page.evaluate(async () => {
    try {
      const c = await navigator.credentials.get({
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: "localhost", userVerification: "preferred", timeout: 20000 },
      });
      return { id: (c as PublicKeyCredential).id };
    } catch (e) {
      return { error: (e as DOMException).name };
    }
  });

const asked = () => l.app.evaluate(() => (globalThis as unknown as { __asked: string[][] }).__asked);
const answer = (a: string) => l.app.evaluate((_e, v) => void ((globalThis as unknown as { __answer: string }).__answer = v), a);

test("the session answers Electron's account question", async () => {
  const n = await l.app.evaluate(({ session }) => session.fromPartition("persist:mafold").listenerCount("select-webauthn-account"));
  expect(n).toBe(1);
});

// (One authenticator holds one passkey per person per site, so "several of one
// person's" only meets the picker across devices — accountChoice covers it.)
test("one passkey: signs in without asking", async () => {
  await passkeys([{ id: "ada-1", user: "u-ada", name: "ada" }]);
  expect(await signIn()).toEqual({ id: b64url("ada-1") });
  expect(await asked()).toEqual([]);
});

test("two people's passkeys: the person picks, and gets that one", async () => {
  await passkeys([
    { id: "ada-1", user: "u-ada", name: "ada" },
    { id: "bob-1", user: "u-bob", name: "bob" },
  ]);
  await answer("bob");
  expect(await signIn()).toEqual({ id: b64url("bob-1") });
  const [buttons] = await asked();
  expect(buttons).toEqual(expect.arrayContaining(["ada", "bob"]));
  expect(buttons).toHaveLength(3); // + cancel
});

test("two people's passkeys, picker dismissed: the page hears a refusal, not silence", async () => {
  await passkeys([
    { id: "ada-1", user: "u-ada", name: "ada" },
    { id: "bob-1", user: "u-bob", name: "bob" },
  ]);
  expect(await signIn()).toEqual({ error: "NotAllowedError" });
});
