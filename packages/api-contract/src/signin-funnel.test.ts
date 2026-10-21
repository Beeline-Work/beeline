import { expect, it } from 'vitest';
import { parseSigninFunnelEvent } from './signin-funnel.js';
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
