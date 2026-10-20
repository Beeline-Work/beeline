import { Redirect } from 'expo-router';

export default function GoogleCallbackFallback() {
  return <Redirect href="/beeline/onboarding" />;
}
