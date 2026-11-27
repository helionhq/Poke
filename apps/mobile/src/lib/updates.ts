import * as Updates from "expo-updates";
import type { Session } from "./session";

/**
 * JS updates come from Poke's own server (brief section 23), behind the device token like every
 * other route. expo-updates only lets the app override headers it declared at build time
 * (app.config.ts `updates.requestHeaders`), so those keys are listed there empty and filled in
 * here once the phone is paired. The override is saved, so the check at the next launch uses it.
 */
export function setUpdateHeaders(session: Session | null): void {
  if (!Updates.isEnabled) return;
  try {
    Updates.setUpdateRequestHeadersOverride(
      session
        ? {
            authorization: `Bearer ${session.token}`,
            ...lowercase(session.headers ?? {}),
          }
        : null,
    );
  } catch {
    // Not available in development builds.
  }
}

/** On resume: fetch a new JS update if there is one; it runs at the next launch. */
export async function fetchUpdateQuietly(): Promise<boolean> {
  if (!Updates.isEnabled || __DEV__) return false;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return false;
    const result = await Updates.fetchUpdateAsync();
    return result.isNew;
  } catch {
    return false;
  }
}

function lowercase(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
