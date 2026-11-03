import type { AuthSessionOpenOptions } from 'expo-web-browser';

/**
 * Android's Custom Tabs proxy activity is singleTop and can retain a previous
 * auth tab. Launching the next bind directly prevents that old proxy task from
 * swallowing the fresh, state-bound authorize URL.
 */
export function authSessionOptions(
  platform: string,
  redirectUri: string,
  _provider?: 'google' | 'github',
): AuthSessionOpenOptions {
  return {
    preferUniversalLinks: redirectUri.startsWith('https://'),
    ...(platform === 'android'
      ? {
          // The launcher must restore an unfinished sign-in tab above Beeline.
          // A separate task would foreground Beeline and report a dismissal.
          createTask: false,
          showInRecents: true,
          useProxyActivity: false,
        }
      : {}),
  };
}
