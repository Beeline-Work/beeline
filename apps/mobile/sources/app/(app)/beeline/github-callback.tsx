import { Redirect } from 'expo-router';

/** Hand an OS-delivered GitHub proof back to the onboarding flow. */
export default function GitHubCallbackFallback() {
  return <Redirect href="/beeline/onboarding" />;
}
