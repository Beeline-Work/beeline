import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  NativeModules: {}, Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
import { LiveConnection } from './live-connection';

it('refuses a raw write even when a caller casts around the read-only type', async () => {
  const authorization = vi.fn();
  const connection = new LiveConnection({
    authorization,
    liveUrl: () => 'wss://server.example/v1/phone/live',
    subscribeIdentityChange: () => () => {},
    subscribeNetworkChange: () => () => {},
  });
  try {
    await expect(connection.request('sendFromWallet' as never, {} as never))
      .rejects.toMatchObject({ code: 'command_required' });
    expect(authorization).not.toHaveBeenCalled();
  } finally { connection.dispose(); }
});
