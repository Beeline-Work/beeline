import { expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: request,
  MonolithPhoneOperationError: class extends Error {},
}));
import { MonolithPhoneOperationError } from '@/sync/transport/monolith-operation';
import { voiceFetch } from './voice-request';

it('preserves the human reason and typed code after command admission wraps a voice refusal', async () => {
  request.mockRejectedValueOnce(Object.assign(new MonolithPhoneOperationError('voiceJoin', 429, 'Calls resume tomorrow'), {
    status: 429, code: 'Calls resume tomorrow', socketCode: 'voice-daily-limit',
  }));
  const result = await voiceFetch('https://proof/v1/phone/voice/id/join', { method: 'POST' });
  expect(result.status).toBe(429);
  expect(await result.json()).toEqual({ error: 'Calls resume tomorrow', code: 'voice-daily-limit' });
});
