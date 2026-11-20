// GENERATED from client-shared/appGround.ts — DO NOT EDIT.
// ── The ground: the colour the app stands on ─────────────────────────────
// What shows behind everything — before the page has painted, between two
// documents, around a window being resized. ONE copy for whatever has to paint
// it before the web app's stylesheet can: the desktop shell compiles a
// generated copy (mafold-desktop/scripts/sync-shared.mjs) for its window's
// background and its offline page. mafold-web's stylesheet writes the same
// values as `--jBg` and as the page's own ground (globals.css), and
// mafold-web/src/app/appGround.spec.ts holds the two to each other. Edit HERE,
// then globals.css.
//
// No imports: this file is copied verbatim.

export const APP_GROUND = {
  /** Signed in, light: `.mafold-app`'s `--jBg`. */
  light: "#f0f0f3",
  /** Signed in, dark — the system's, or picked in Settings ▸ Appearance. */
  dark: "#1c1c1e",
  /** Signed out: the sign-in door wears the landing's cream in either
   *  appearance. The desktop shell can't tell signed in from signed out when it
   *  opens its window, so the window stands on the app's ground and a door
   *  arrives in cream. */
  signedOut: "#FBF6EF",
} as const;
