import { clearBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clearPendingGitHubSignInState } from '@/auth/github-auth-session';
import { monolithSession, MonolithSession } from '@/auth/monolith-session';
import { clearMobileSurfaceStorage } from '@/buzz/surface-storage';

/**
 * Redeem a Google Play review link.
 *
 * The device may already hold somebody else's session — a reviewer opening the
 * link on a device that has been used before — so this signs that identity out
 * FIRST, cache included, and only then signs in as the review identity. A
 * failed redemption leaves the device signed out rather than half-way between
 * two identities; the caller sends it to the ordinary sign-in screen.
 * An already accepted link for this session is idempotent: Android may replay
 * its original launch Intent when an OTA reloads JavaScript.
 *
 * Nothing here is reachable from a control: only the verified `/review/…` app
 * link routes into it, so no screen changes for anyone else.
 */
export async function signInWithReviewSecret(
  secret: string,
  session: MonolithSession = monolithSession,
): Promise<string> {
  const alreadyAccepted = await session.reviewIdentityForSecret(secret);
  if (alreadyAccepted) return alreadyAccepted;
  await session.signOut();
  await Promise.all([clearBuzzIdentity(), clearPendingGitHubSignInState()]);
  clearMobileSurfaceStorage();
  return session.exchangeReviewSecret(secret);
}
