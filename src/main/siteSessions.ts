// Which sessions are the sites' own: the one every site tab shares, the
// incognito one, and one per browser profile brought in (cap
// `browser-profiles`). A profile's session counts only once sites.ts has put
// the sites' guards on it. Its own module, so sites.ts, security.ts and
// shell.ts can all ask without importing each other.

import { session as electronSession, type Session } from "electron";

import { SITE_INCOGNITO_PARTITION, SITE_PARTITION } from "../shared/desktopHost.generated";

/** Partition → the profile it holds, and its session. */
const profiles = new Map<string, { profile: string; ses: Session }>();

export function addProfileSession(partition: string, profile: string, ses: Session): void {
  profiles.set(partition, { profile, ses });
}

export const hasProfileSession = (partition: string): boolean => profiles.has(partition);

/** The site session `ses` is, or null: its partition, and for a profile's
 *  session, the profile's id. */
export function siteSessionOf(ses: Session): { partition: string; profile?: string } | null {
  for (const partition of [SITE_PARTITION, SITE_INCOGNITO_PARTITION]) if (ses === electronSession.fromPartition(partition)) return { partition };
  for (const [partition, p] of profiles) if (ses === p.ses) return { partition, profile: p.profile };
  return null;
}
