import { expect, it } from 'vitest';
import { funnelScreenFromSegments, parseSigninFunnelEvent } from './signin-funnel.js';
const valid = {
  event: 'app_opened',
  installId: '00000000-0000-4000-8000-000000000001',
  attemptId: '00000000-0000-4000-8000-000000000002',
  platform: 'android',
  version: '0.2.22',
  environment: 'production',
  timestamp: new Date().toISOString(),
};
it('accepts only the fixed event schema and enums', () => {
  expect(parseSigninFunnelEvent(valid)).not.toBeNull();
  for (const patch of [
    { event: 'pageview' },
    { platform: 'device-name' },
    { installId: 'account-id' },
    { timestamp: 'never' },
    { version: 'person@example.com' },
    { event: 'callback_result', provider: 'github', outcome: 'error', errorCode: 'token=secret' },
  ])
    expect(parseSigninFunnelEvent({ ...valid, ...patch })).toBeNull();
});
it('bounds onboarding options and viewer durations without accepting free text', () => {
  expect(parseSigninFunnelEvent({ ...valid, event: 'option_picked', option: 'D' })).not.toBeNull();
  expect(parseSigninFunnelEvent({ ...valid, event: 'game_viewer_closed', durationMs: 1234 })).not.toBeNull();
  expect(parseSigninFunnelEvent({ ...valid, event: 'game_viewer_opened', artifactId: valid.installId })).not.toBeNull();
  for (const patch of [
    { event: 'option_picked', option: 'custom task' },
    { event: 'app_opened', option: 'A' },
    { event: 'option_picked', durationMs: 12 },
    { event: 'game_viewer_closed', durationMs: -1 },
    { event: 'game_viewer_closed', durationMs: 86_400_001 },
    { event: 'game_viewer_opened', artifactId: 'https://example.com/private-game' },
    { event: 'app_opened', artifactId: valid.installId },
  ]) expect(parseSigninFunnelEvent({ ...valid, ...patch })).toBeNull();
});
it.each([
  'email',
  'name',
  'login',
  'ip',
  'deviceName',
  'code',
  'token',
  'accountId',
  'authorization',
  'identityId',
])('refuses personal field %s', (field) => {
  expect(parseSigninFunnelEvent({ ...valid, [field]: 'private' })).toBeNull();
});
const screen = { ...valid, event: 'screen_shown', screen: 'beeline/chat/[channelId]' };
it('accepts a screen event only for an allowlisted route pattern', () => {
  expect(parseSigninFunnelEvent(screen)).not.toBeNull();
  for (const value of [
    undefined,
    'beeline/chat/7f3a9c',
    'beeline/chat/[channelId]?name=Ada',
    '(app)/beeline/tray',
    'Ada Lovelace',
    'pageview',
    42,
  ])
    expect(parseSigninFunnelEvent({ ...screen, screen: value })).toBeNull();
  expect(parseSigninFunnelEvent({ ...valid, screen: 'beeline/tray' })).toBeNull();
  expect(parseSigninFunnelEvent({ ...screen, provider: 'github' })).toBeNull();
});
it.each(['text', 'name', 'id', 'params', 'channelId', 'title', 'email'])(
  'refuses extra field %s on a screen event',
  (field) => {
    expect(parseSigninFunnelEvent({ ...screen, [field]: 'private' })).toBeNull();
  },
);
it('maps route segments to a pattern without groups or index', () => {
  expect(funnelScreenFromSegments(['(app)'])).toBe('index');
  expect(funnelScreenFromSegments(['(app)', 'beeline', 'settings', 'index'])).toBe('beeline/settings');
  expect(funnelScreenFromSegments(['(app)', 'beeline', 'chat', '[channelId]'])).toBe('beeline/chat/[channelId]');
  expect(funnelScreenFromSegments(['(app)', 'beeline', 'chat', 'abc123'])).toBeNull();
});
it.each(['banter_shown', 'repo_job_chosen', 'youtube_job_chosen', 'other_job_chosen'])('records the starter milestone %s without personal fields', event => {
  expect(parseSigninFunnelEvent({ ...valid, event })).not.toBeNull();
  expect(parseSigninFunnelEvent({ ...valid, event, name: 'private' })).toBeNull();
});
