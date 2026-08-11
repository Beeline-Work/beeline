import { Redirect } from 'expo-router';

/** Fallback when the OS delivers the callback outside the active browser session. */
export default function OidcCallbackFallback() {
  return <Redirect href="/buzz/onboarding" />;
}
