import { afterEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => sdk);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.resetModules(); });

it('initializes production capture in JS-only mode and filters SDK event enrichment', async () => {
  vi.stubGlobal('__DEV__', false); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  await import('./sentry');
  expect(sdk.init).toHaveBeenCalledOnce();
  const options = sdk.init.mock.calls[0]![0];
  expect(options).toMatchObject({ enableNative: false, sendDefaultPii: false, maxBreadcrumbs: 0,
    enableAutoSessionTracking: false, attachScreenshot: false, attachViewHierarchy: false });
  const filtered = options.beforeSend({ message: 'Bearer private user@example.com', user: { email: 'private' },
    request: { data: 'chat text' }, breadcrumbs: [{ message: 'private' }] });
  expect(filtered.message).toBe('Bearer [redacted] [email]');
  expect(filtered.user).toBeUndefined(); expect(filtered.request).toBeUndefined(); expect(filtered.breadcrumbs).toBeUndefined();
});
it('does not initialize development builds even with a release DSN present', async () => {
  vi.stubGlobal('__DEV__', true); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  await import('./sentry'); expect(sdk.init).not.toHaveBeenCalled();
});
it('keeps SDK initialization and reporting failures out of the recovery path', async () => {
  vi.stubGlobal('__DEV__', false); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  sdk.init.mockImplementationOnce(() => { throw new Error('SDK unavailable'); });
  const { captureMobileError } = await import('./sentry');
  sdk.captureException.mockImplementationOnce(() => { throw new Error('offline'); });
  expect(() => captureMobileError('app', new Error('render failed'))).not.toThrow();
});

it('Reproduction SENTRY-6: old iPhone update messages remain intact without Sentry capture', async () => {
  const { captureMobileError } = await import('./sentry');
  for (const message of [
    'Update Beeline from the App Store to use Conversation mode.',
    'Update Beeline in the App Store to join calls.',
  ]) {
    const cause = new Error(message);
    captureMobileError('voice-join', cause);
    expect(cause.message).toBe(message);
  }
  expect(sdk.captureException).not.toHaveBeenCalled();
  const unexpected = new Error('Voice connection failed');
  captureMobileError('voice-join', unexpected);
  expect(sdk.captureException).toHaveBeenCalledWith(unexpected, expect.anything());
});
