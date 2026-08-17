import { useEffect, useRef } from "react";

import {
  backgroundScopeClaimsKey,
  retainBackgroundScopes,
  type BackgroundScopeClaim,
} from "../lib/backgroundActivityReporter";

/**
 * Claims background demand for `claims` while the caller is mounted.
 *
 * Surfaces that read server-maintained state say so here rather than the client
 * polling for it: the claim rides the next activity report and the server keeps
 * that scope's periodic work running while some client holds it. Passing an
 * empty array claims nothing, which is how a surface expresses "not right now"
 * — a popover that is closed, say — without breaking the rules of hooks.
 *
 * Claims are compared by value, so callers may rebuild the array on every
 * render; the underlying claim is only released and re-taken when its contents
 * change.
 */
export function useBackgroundScopes(claims: readonly BackgroundScopeClaim[]): void {
  const key = backgroundScopeClaimsKey(claims);
  const latestClaims = useRef(claims);
  latestClaims.current = claims;

  useEffect(() => retainBackgroundScopes(latestClaims.current), [key]);
}
