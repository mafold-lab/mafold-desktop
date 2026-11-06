// A job's first Electron reads everything from a cold disk, so its GPU process,
// where the compositing happens, comes up seconds late. Until it has, a capture
// gets no answer, and the one waiting when it arrives throws UnknownVizError:
// cover.spec.ts failed that way, on Ubuntu, in the suite's first launch only.
// That is the machine's time, not any test's, so one launch spends it here.
//
// An evaluate reaches the main process as an interrupt, so one sent right after
// launch can land inside `new WebContentsView`, and a call on the half-built
// WebContents is a SIGSEGV: about 1 launch in 45 here, none in 150 with no
// evaluate, none in 150 after firstWindow(), which comes once the window is built.
// This launch stops nothing if it fails: every test launches for itself.

import { start } from "./fixtures";

const NOBODY = "http://127.0.0.1:9";
const LIMIT_MS = 30_000;

export default async function warmUp(): Promise<void> {
  const t0 = Date.now();
  try {
    const { app } = await start(NOBODY, NOBODY);
    try {
      await app.firstWindow();
      const answered = await app.evaluate(async ({ webContents }, limit) => {
        for (const until = Date.now() + limit; Date.now() < until; ) {
          const shot = await Promise.race([
            webContents.getAllWebContents()[0]?.capturePage().catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 1000)),
          ]);
          if (shot && !shot.isEmpty()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      }, LIMIT_MS);
      console.log(`warm-up: first capture ${answered ? "after" : "not within"} ${Date.now() - t0} ms`);
    } finally {
      await app.close();
    }
  } catch (e) {
    console.log(`warm-up: gave up after ${Date.now() - t0} ms: ${String(e).split("\n")[0]}`);
  }
}
