import { expect, it, vi } from 'vitest';
const os = vi.hoisted(() => ({ listener: undefined as (() => void) | undefined, remove: vi.fn() }));
vi.mock('expo-notifications', () => ({ addPushTokenListener: (listener: () => void) => {
  os.listener = listener; return { remove: os.remove };
} }));
import * as native from './push-token-events';
import * as web from './push-token-events.web';

it('observes the native token event and releases it; web keeps its service-worker owner', () => {
  const webContract: typeof native = web;
  const changed = vi.fn();
  const stop = native.subscribePushTokenChanges(changed);
  os.listener!();
  expect(changed).toHaveBeenCalledOnce();
  stop();
  expect(os.remove).toHaveBeenCalledOnce();
  webContract.subscribePushTokenChanges(changed)();
  expect(changed).toHaveBeenCalledOnce();
});
