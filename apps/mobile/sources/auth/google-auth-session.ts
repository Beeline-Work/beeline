import type { AuthSessionOpenOptions } from 'expo-web-browser';

/**
 * Android's Custom Tabs proxy activity is singleTop and can retain a previous
 * auth tab. Launching the next bind directly prevents that old proxy task from
 * swallowing the fresh, state-bound authorize URL.
 */
export function googleAuthSessionOptions(
  platform: string,
  redirectUri: string,
): AuthSessionOpenOptions {
  return {
    preferUniversalLinks: redirectUri.startsWith('https://'),
    ...(platform === 'android'
      ? {
          createTask: true,
          useProxyActivity: false,
        }
      : {}),
  };
}
