import { expect, it, vi } from 'vitest';
const observed = vi.hoisted(() => ({ activation: vi.fn(), called: undefined as (() => void) | undefined }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.3' } } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-id' }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
vi.mock('@beeline/api-contract/signin-funnel-client', () => ({
  createSigninFunnelClient: () => ({ activation: observed.activation }),
}));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => false }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://fixture.invalid' }) }));
vi.mock('./monolith-session', () => ({ monolithSession: { authorization: async () => 'fixture-authorization' } }));
import { publishPhoneLiveEvent } from '@/sync/transport/phone-live-events';
import './signin-funnel';

it('observes successful command outcomes inside the sign-in domain', async () => {
  observed.activation.mockImplementation(async () => { observed.called?.(); });
  const activated = new Promise<void>(resolve => { observed.called = resolve; });
  publishPhoneLiveEvent({ type: 'operation-completed', operation: 'sendRoomMessage' });
  await activated;
  expect(observed.activation).toHaveBeenCalledExactlyOnceWith('first_message_sent', 'fixture-authorization');
});
