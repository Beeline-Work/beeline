import { afterEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn(), setTag: vi.fn() }));
vi.mock('@sentry/react-native', () => sdk);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.resetModules(); });

it('R-SENTRY-ROUTE: phone and web events retain an allowlisted screen pattern without parameter values', async () => {
  vi.stubGlobal('__DEV__', false); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  const { setMobileErrorRoute } = await import('./sentry');
  const { beforeSend } = sdk.init.mock.calls[0]![0];
  for (const [segments, route] of [
    [['(app)', 'beeline', 'chat', '[channelId]'], 'beeline/chat/[channelId]'],
    [['(app)', 'beeline', 'corners', '[roomId]'], 'beeline/corners/[roomId]'],
    [['(app)', 'review', '[secret]'], 'review/[secret]'],
    [['(app)', 'beeline', 'settings', 'index'], 'beeline/settings'],
  ] as const) {
    setMobileErrorRoute(segments);
    expect(sdk.setTag).toHaveBeenLastCalledWith('route_pattern', route);
    const event = beforeSend({ message: `crash on ${route}`, tags: {
      surface: 'mobile', route_pattern: route, room_id: 'private-room',
    }, request: { url: 'https://web.usebeeline.app/beeline/chat/private-room?name=private' } });
    expect(event.tags).toEqual({ surface: 'mobile', route_pattern: route });
    expect(event.request).toBeUndefined();
  }
  // A navigation change must not keep the previous screen when unrecognized.
  setMobileErrorRoute(['beeline', 'chat', 'private-room']);
  expect(sdk.setTag).toHaveBeenLastCalledWith('route_pattern', undefined);
  expect(beforeSend({ message: 'anonymous fill crash', tags: { route_pattern: 'beeline/chat/private-room' } }).tags).toEqual({});
});

it('keeps route-tag SDK failures out of navigation', async () => {
  const { setMobileErrorRoute } = await import('./sentry');
  sdk.setTag.mockImplementationOnce(() => { throw new Error('SDK unavailable'); });
  expect(() => setMobileErrorRoute(['beeline', 'onboarding'])).not.toThrow();
});

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

it('R-SENTRY-REPEAT: applies the shared cap to SDK events while preserving private filtering', async () => {
  vi.stubGlobal('__DEV__', false); vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  await import('./sentry');
  const { beforeSend } = sdk.init.mock.calls[0]![0];
  const event = (pid: number) => ({ exception: { values: [{ type: 'Error', value: `owner ${pid} failed` }] }, request: { data: 'private' } });
  expect(beforeSend(event(695))).toMatchObject({ exception: { values: [{ value: 'owner 695 failed' }] } });
  expect(beforeSend(event(696))).toBeNull();
  expect(beforeSend({ message: 'a different error' })).not.toBeNull();
});
