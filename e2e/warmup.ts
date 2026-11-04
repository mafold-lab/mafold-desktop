// A job's first Electron reads everything from a cold disk, so its GPU process,
// where the compositing happens, comes up seconds late. Until it has, a capture
// gets no answer, and the one waiting when it arrives throws UnknownVizError:
// cover.spec.ts failed that way, on Ubuntu, in the suite's first launch only.
// That is the machine's time, not any test's, so one launch spends it here.

import { start } from "./fixtures";

const NOBODY = "http://127.0.0.1:9";
const LIMIT_MS = 30_000;

export default async function warmUp(): Promise<void> {
  const t0 = Date.now();
  const { app } = await start(NOBODY, NOBODY);
  try {
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
}
