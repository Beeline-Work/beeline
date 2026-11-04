import { expect, it, vi } from 'vitest';
const callback = vi.hoisted(() => vi.fn());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.2.22' } } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('expo-updates', () => ({ updateId: '11111111-1111-4111-8111-111111111111', isEmbeddedLaunch: false }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => false }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.usebeeline.app' }) }));
vi.mock('@beeline/api-contract/signin-funnel-client', () => ({ createSigninFunnelClient: () => ({ callback, begin: vi.fn() }) }));
import { beginFunnelAttempt, funnelCallback } from './signin-funnel';
import { observeAuthSessionResult } from './auth-session-diagnostics';

it('attaches native error and actual OTA ID to the final cancelled outcome', async () => {
  await beginFunnelAttempt('github');
  observeAuthSessionResult({ type: 'cancel', errorDomain: 'com.apple.AuthenticationServices.WebAuthenticationSession', errorCode: '3', error: 'private localized text', url: 'beeline://private' });
  await funnelCallback('cancelled', undefined, { code: 'browser_canceled' });
  expect(callback).toHaveBeenLastCalledWith('cancelled', undefined, {
    resultType: 'cancel', errorDomain: 'com.apple.AuthenticationServices.WebAuthenticationSession', errorCode: '3', updateId: '11111111-1111-4111-8111-111111111111',
  });
  await beginFunnelAttempt('google');
  await funnelCallback('error', 'unknown', { code: 'ERR_WEB_BROWSER_ALREADY_OPEN' });
  expect(callback).toHaveBeenLastCalledWith('error', 'unknown', {
    errorDomain: undefined, errorCode: 'ERR_WEB_BROWSER_ALREADY_OPEN', updateId: '11111111-1111-4111-8111-111111111111',
  });
});
