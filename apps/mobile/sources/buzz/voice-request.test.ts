import { beforeEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ request }) }));
import { voiceFetch } from './voice-request';
import { PhoneSocketError } from '@/sync/transport/phone-socket-error';
beforeEach(() => { request.mockReset(); });
it.each([
  ['join', 'POST', { expectedCallId: 'expected' }, 'voiceJoin', { roomId: 'id', expectedCallId: 'expected' }],
  ['current', 'GET', undefined, 'voiceCurrent', { roomId: 'id' }],
  ['state?sessionId=session', 'GET', undefined, 'voiceState', { callId: 'id', sessionId: 'session' }],
  ['leave', 'POST', { sessionId: 'session' }, 'voiceLeave', { callId: 'id', sessionId: 'session' }],
  ['idle', 'POST', { sessionId: 'session' }, 'voiceIdle', { callId: 'id', sessionId: 'session' }],
  ['resume', 'POST', { sessionId: 'session' }, 'voiceResume', { callId: 'id', sessionId: 'session' }],
] as const)('routes voice %s over the shared socket', async (action, method, body, op, args) => {
  request.mockResolvedValueOnce({ result: true });
  const response = await voiceFetch(`https://proof/v1/phone/voice/id/${action}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect(await response.json()).toEqual({ result: true });
  expect(request).toHaveBeenCalledExactlyOnceWith(op, args, { timeoutMs: 20_000, signal: undefined });
});
it('keeps daily-limit refusals and cancellation available to the call UI', async () => {
  const controller = new AbortController();
  request.mockRejectedValueOnce(new PhoneSocketError('voice-daily-limit', 'Calls resume at 12:00 AM', false));
  const response = await voiceFetch('https://proof/v1/phone/voice/id/join', { method: 'POST', signal: controller.signal });
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ code: 'voice-daily-limit', error: 'Calls resume at 12:00 AM' });
  expect(request.mock.calls[0]?.[2].signal).toBe(controller.signal);
  request.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await expect(voiceFetch('https://proof/v1/phone/voice/id/join', { method: 'POST' })).rejects.toMatchObject({ name: 'AbortError' });
});
