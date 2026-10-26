import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import type { FunnelScreen, SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { createSigninFunnelClient } from '@beeline/api-contract/signin-funnel-client';
import { isDesktopShell } from '@/utils/isDesktopShell';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

let client: Promise<ReturnType<typeof createSigninFunnelClient> | null> | undefined;
function getClient() {
  return (client ??= (async () => {
    let platform: SigninFunnelEvent['platform'] =
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    let version = Constants.expoConfig?.version ?? '',
      environment: SigninFunnelEvent['environment'] = 'production';
    if (typeof __DEV__ !== 'undefined' && __DEV__) environment = 'development';
    const channel = Constants.expoConfig?.updates?.requestHeaders?.['expo-channel-name'];
    if (channel && channel !== 'production') environment = 'preview';
    if (/preview|lab|dev/i.test(Constants.expoConfig?.name ?? '')) environment = 'preview';
    if (isDesktopShell()) {
      const app = await import('@tauri-apps/api/app');
      version = await app.getVersion();
      const identifier = await app.getIdentifier();
      if (/preview|lab|dev/i.test(identifier)) environment = 'preview';
      const os = globalThis.navigator?.platform ?? '';
      platform = /mac/i.test(os) ? 'macos' : /win/i.test(os) ? 'windows' : 'linux';
    } else if (
      platform === 'web' &&
      !['usebeeline.app', 'www.usebeeline.app', 'app.usebeeline.app'].includes(
        globalThis.location?.hostname,
      )
    )
      environment = 'preview';
    if (!/^\d+\.\d+\.\d+/.test(version)) return null;
    const base = getBuzzRuntimeConfig().monolithUrl;
    if (!['https://server.usebeeline.app', 'https://beeline-server.fly.dev'].includes(base))
      environment = 'lab';
    return createSigninFunnelClient({
      storage: AsyncStorage,
      uuid: randomUUID,
      platform,
      version,
      environment,
      send: async (event, authorization) => {
        const fetcher = isDesktopShell() ? (await import('@tauri-apps/plugin-http')).fetch : fetch;
        const controller = new AbortController(),
          timeout = setTimeout(() => controller.abort(), 3000);
        try {
          await fetcher(`${base}/v1/funnel/events`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
            },
            body: JSON.stringify(event),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      },
    });
  })().catch(() => null));
}
export async function funnelOpened(signedIn: boolean, newOpen = false, authorization?: string) {
  await (await getClient())?.opened(signedIn, newOpen, authorization);
}
export async function funnelScreen() {
  await (await getClient())?.screen();
}
/** First-session screen reach after sign-in; sends the route pattern only. */
export async function funnelScreenShown(screen: FunnelScreen) {
  await (await getClient())?.screenShown(screen, async () => {
    const { monolithSession } = await import('./monolith-session');
    return monolithSession.authorization();
  });
}
export async function beginFunnelAttempt(provider: 'github' | 'google') {
  return (await getClient())?.begin(provider);
}
export async function pendingFunnelAttempt() {
  return (await getClient())?.pending();
}
export async function funnelCallback(
  outcome: 'success' | 'cancelled' | 'error',
  errorCode?: SigninFunnelEvent['errorCode'],
) {
  await (await getClient())?.callback(outcome, errorCode);
}
export async function funnelSignedIn(authorization: string) {
  await (await getClient())?.signedIn(authorization);
}
export async function suppressSigninFunnel() {
  (await getClient())?.suppress();
}

/** Observe only successful writes; no message, Workspace or identity data leaves here. */
export async function funnelSuccessfulOperation(name: string) {
  const event = name === 'createWorkspace' ? 'workspace_created'
    : name === 'sendRoomMessage' || name === 'sendRoomReply' ? 'first_message_sent' : null;
  if (!event) return;
  const funnel = await getClient();
  if (!funnel) return;
  const { monolithSession } = await import('./monolith-session');
  await funnel.activation(event, await monolithSession.authorization());
}

export async function funnelOnboarding(event: 'welcome_shown' | 'game_viewer_opened' | 'game_viewer_closed' | 'invite_shared', durationMs?: number) {
  try {
    const funnel = await getClient();
    if (!funnel) return;
    const { monolithSession } = await import('./monolith-session');
    await funnel.onboarding(event, await monolithSession.authorization(), durationMs);
  } catch {
    // Measurement must not interrupt a card, viewer or share sheet.
  }
}
