import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticSentryAlert, sendSentryTelegram, sentryTelegramMessage } from './sentry-telegram.js';
import { createBeelineServer, type ServerOptions } from './server.js';
import { LiveHub } from './live.js';
const capture = vi.hoisted(() => vi.fn());
vi.mock('./sentry.js', () => ({ captureServerError: capture }));
const config = { token: 'webhook-secret', botToken: 'bot-secret', chatId: 'chat-fixture' };
const servers: ReturnType<typeof createBeelineServer>[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });

it('fails closed without configuration and authenticates the exact query token', () => {
  expect(authenticSentryAlert(undefined, config.token)).toBe(false);
  expect(authenticSentryAlert(config, null)).toBe(false);
  expect(authenticSentryAlert(config, 'wrong')).toBe(false);
  expect(authenticSentryAlert(config, config.token)).toBe(true);
});
it('formats modern and legacy alerts, limits text and refuses foreign links', () => {
  expect(sentryTelegramMessage({ data: { issue: { title: 'Test issue', web_url: 'https://beeline-bt.sentry.io/issues/123/' }, event: { level: 'fatal' } } }))
    .toBe('🔴 Beeline fatal: Test issue https://beeline-bt.sentry.io/issues/123/');
  expect(sentryTelegramMessage({ event: { title: 'Failed Bearer private user@example.com', level: 'error' }, url: 'https://evil.test/?secret=x' }))
    .toBe('🔴 Beeline error: Failed Bearer [redacted] [email] https://beeline-bt.sentry.io/issues/');
  expect(sentryTelegramMessage({})).toBeNull();
  expect(sentryTelegramMessage({ message: 'x'.repeat(10_000) })!.length).toBeLessThan(2000);
});
it('posts outbound only, requires Telegram acknowledgement and never leaks its token on failure', async () => {
  const send = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
  await sendSentryTelegram(config, '🔴 Beeline error: fixture', send);
  expect(send.mock.calls[0]).toEqual(['https://api.telegram.org/botbot-secret/sendMessage', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ chat_id: 'chat-fixture', text: '🔴 Beeline error: fixture', link_preview_options: { is_disabled: true } }),
  })]);
  await expect(sendSentryTelegram(config, 'fixture', async () => { throw new Error('https://api.telegram.org/botbot-secret/sendMessage'); }))
    .rejects.toThrow(/^Beeline Sentry Telegram delivery failed$/);
  await expect(sendSentryTelegram(config, 'fixture', async () => new Response('{"ok":false}', { status: 200 })))
    .rejects.toThrow(/^Beeline Sentry Telegram delivery failed$/);
});
it('serves the webhook before phone auth, rejects invalid input and returns retryable failures', async () => {
  const server = createBeelineServer({ database: {}, auth: {}, phone: {}, daemon: {}, live: new LiveHub(),
    mediaMaximumBytes: 1, sentryTelegram: config } as unknown as ServerOptions);
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const actualFetch = globalThis.fetch;
  const delivery = vi.fn(async () => new Response('{"ok":true}'));
  vi.stubGlobal('fetch', delivery);
  const post = (token: string, payload: unknown) => actualFetch(`${origin}/api/webhooks/sentry?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  expect((await post('wrong', { message: 'test' })).status).toBe(401);
  expect((await post(config.token, {})).status).toBe(400);
  expect(delivery).not.toHaveBeenCalled();
  expect((await post(config.token, { message: 'Beeline E2E test server' })).status).toBe(200);
  expect(delivery).toHaveBeenCalledTimes(1);
  delivery.mockRejectedValueOnce(new Error('bot-secret'));
  const failed = await post(config.token, { message: 'test' });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('bot-secret');
  expect(capture).not.toHaveBeenCalled();
});

it('captures unexpected server request failures without changing their response', async () => {
  const server = createBeelineServer({ database: {}, auth: { authenticatePhone: async () => 'fixture' },
    phone: { readRoom: async () => { throw new Error('Beeline Sentry test server request'); } }, daemon: {},
    live: new LiveHub(), mediaMaximumBytes: 1 } as unknown as ServerOptions);
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/rooms/00000000-0000-0000-0000-000000000000`, {
    headers: { authorization: 'Bearer isolated-sentry-proof-token' },
  });
  expect(response.status).toBe(503);
  expect(capture).toHaveBeenCalledWith(expect.any(Error));
});
