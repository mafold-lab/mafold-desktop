// Passkeys inside the app — the pure half (`security.ts` wires it to Electron).
//
// Electron services no platform authenticator until `app.configureWebAuthn`
// is called, and Chromium uses the Touch ID one only when the signed app holds
// the keychain access group it is handed. Without both, the page sees
// `isUserVerifyingPlatformAuthenticatorAvailable() === false`, and a passkey
// request waits — no prompt, no error, nothing on screen — until it times out
// (five minutes against our server), then reads as a cancellation. That was
// the whole of "passkeys don't work in the desktop app" (desktop 0.1.0–0.1.1).
//
// The group has to match `keychain-access-groups` in build/entitlements.mac.plist,
// and that entitlement is restricted: it is only honoured because
// build/Mafold_Desktop_DeveloperID.provisionprofile authorises it, and an app
// that claims it WITHOUT the profile is refused at launch. test/webauthn.spec.ts
// keeps the three in step.
//
// What these passkeys are: bound to this Mac's Secure Enclave and to this
// app's session, never synced. They cannot see the iCloud Keychain passkeys
// Safari or Chrome made, which is why the page only asks for the ones it made
// here and lets everyone else in with their password (mafold-web lib/passkey.ts).

/** The Apple team every Mafold build is signed by. */
export const TEAM_ID = "UGZPUZZYDD";

/** Where Touch ID passkeys are stored — `<TEAM_ID>.<bundle id>.webauthn`. */
export const KEYCHAIN_ACCESS_GROUP = `${TEAM_ID}.com.mafold.desktop.webauthn`;

/** One passkey an authenticator offers (Electron's `WebAuthnAccount`). */
export interface PasskeyAccount {
  credentialId: string;
  name?: string;
  displayName?: string;
  userHandle?: string;
}

export type AccountChoice = { pick: string } | { ask: PasskeyAccount[] } | { cancel: true };

/**
 * What to do when a sign-in matches more than one passkey on this Mac.
 *
 * Several credentials of ONE account (same user handle) leave nothing to
 * decide — any of them proves the same person — so the first is used.
 * Different accounts are the person's choice. Electron cancels the request if
 * nobody answers, so there is always an answer, even for an empty list.
 */
export function accountChoice(accounts: readonly PasskeyAccount[]): AccountChoice {
  if (accounts.length === 0) return { cancel: true };
  const people = new Set(accounts.map((a) => a.userHandle || a.credentialId));
  if (people.size === 1) return { pick: accounts[0].credentialId };
  return { ask: [...accounts] };
}

/** A button label for one account: "Ada Lovelace (ada)", or whichever half
 *  exists. No "@": a child window signing in to someone else's site gets the
 *  same picker, and their `name` is often an email. */
export function accountLabel(a: PasskeyAccount): string {
  const name = a.name?.trim();
  const display = a.displayName?.trim();
  if (name && display && display !== name) return `${display} (${name})`;
  return name || display || a.credentialId.slice(0, 12);
}
