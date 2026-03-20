/**
 * Returns true only when ALL conditions hold:
 *   1. NODE_ENV is not 'production' (Next.js / build-time signal)
 *   2. VERCEL_ENV is not 'production' (Vercel system env — harder to accidentally override)
 *   3. DEBUG_API_ENABLED=true is explicitly set in the environment
 *
 * Checking both NODE_ENV and VERCEL_ENV provides defense-in-depth: if one is
 * accidentally misconfigured in the production environment the other still blocks
 * access.  Either production signal alone is sufficient to deny.
 *
 * Developers must add DEBUG_API_ENABLED=true to .env.local to use these routes.
 */
export function isDebugAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.VERCEL_ENV === 'production') return false;
  return process.env.DEBUG_API_ENABLED === 'true';
}
