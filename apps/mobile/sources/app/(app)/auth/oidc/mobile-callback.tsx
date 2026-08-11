import { Redirect } from 'expo-router';

/** Fallback when an associated-link completion cold-starts outside the active auth session. */
export default function AssociatedOidcCallbackFallback() {
  return <Redirect href="/buzz/onboarding" />;
}
