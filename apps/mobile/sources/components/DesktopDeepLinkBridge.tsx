import React from 'react';
import { useRouter } from 'expo-router';
import { subscribeToAuthUrls } from '@/auth/desktop-auth-session';
import { deliverDesktopDeepLink } from '@/auth/desktop-deep-link';
import { isSignInInFlight } from '@/auth/onboarding-state';
import { isTauri } from '@/utils/isTauri';

/** Warm native URLs enter here, above every route. Cold URLs are consumed by
 * the app index through `initialAuthUrl`, before its identity redirect runs. */
export function DesktopDeepLinkBridge() {
  const router = useRouter();

  React.useEffect(() => {
    if (!isTauri()) return;
    let removed = false;
    let subscription: { remove(): void } | undefined;
    const deliver = (url: string) => {
      // The sign-in session subscribed before opening the browser and owns this
      // callback. Routing it as well would mount a second onboarding flow over
      // the one that is about to enter Beeline.
      if (isSignInInFlight() && url.startsWith('beeline://beeline/github-callback?')) return;
      deliverDesktopDeepLink(url, router);
    };

    void Promise.resolve(subscribeToAuthUrls(deliver)).then((next) => {
      if (removed) next.remove();
      else subscription = next;
    });
    return () => {
      removed = true;
      subscription?.remove();
    };
  }, [router]);

  return null;
}
