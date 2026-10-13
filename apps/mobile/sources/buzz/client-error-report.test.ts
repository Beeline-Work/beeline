import { expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 204 })));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: send } }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://proof.test' }) }));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => ({ releaseSha: 'proof-sha' }) }));
vi.mock('expo-updates', () => ({ runtimeVersion: '34', updateId: 'test-update' }));
vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 36 } }));
import { errorDiagnostic, reportClientError, reportNativeCrash } from './client-error-report';
it('reports bounded error text, stack and release identity without bearer credentials', async () => {
  const cause = new Error('Failed https://example.test/?token=secret Bearer opaque-secret');
  await reportClientError('voice-join', cause);
  const [url, init] = send.mock.calls[0] as unknown as [string, { body: string }];
  expect(url).toContain('/observations/client-error');
  expect(JSON.parse(init.body)).toMatchObject({ scope: 'voice-join', platform: 'android', platformVersion: '36', releaseSha: 'proof-sha', runtimeVersion: '34', updateId: 'test-update' });
  expect(init.body).not.toContain('opaque-secret');
  expect(init.body).not.toContain('token=secret');
  expect(errorDiagnostic(new Error('x'.repeat(5000))).message).toHaveLength(2048);
});
it('does not reject when telemetry fails', async () => {
  send.mockRejectedValueOnce(new Error('offline'));
  await expect(reportClientError('app', new Error('render failed'))).resolves.toBeUndefined();
});

it('retains native WebRTC rejection messages even when they are not Error instances', () => {
  expect(errorDiagnostic({ name: 'NotAllowedError', message: 'Microphone permission denied' }).message).toBe('Microphone permission denied');
});

it('reports native exception frames and crashed device/version, retaining on non-success responses', async () => {
  const report = { id: 'receipt', timestamp: 1234, device: 'Samsung fixture', appVersion: '0.1.50',
    platformVersion: '16 (API 36)', releaseSha: 'crashed-sha', runtimeVersion: '34', updateId: 'crashed-update',
    message: 'SIGABRT', stack: Array.from({ length: 12 }, (_, i) => `#${i} libwebrtc.so`).join('\n') };
  expect(await reportNativeCrash(report)).toBe(true);
  const [, init] = send.mock.calls.at(-1)! as unknown as [string, { body: string }];
  expect(JSON.parse(init.body)).toMatchObject({ scope: 'native-crash', device: report.device, appVersion: '0.1.50',
    releaseSha: 'crashed-sha', crashTimestamp: '1234', stack: report.stack });
  send.mockResolvedValueOnce(new Response(null, { status: 503 }));
  expect(await reportNativeCrash(report)).toBe(false);
});
