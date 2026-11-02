import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, database, store, alphaTenant, useAuthServerFixture } from './server-test-fixture.js';
const listeners = new Map<string, Set<() => void>>();
useAuthServerFixture({ subscribeCompletion: (hash, wake) => {
  const group = listeners.get(hash) ?? new Set(); listeners.set(hash, group); group.add(wake);
  return () => { group.delete(wake); if (!group.size) listeners.delete(hash); };
} });
let stop: () => Promise<void>;
beforeEach(async () => {
  stop = await database.client.listen('beeline_command_completion', raw => {
    const event = JSON.parse(raw);
    if (event.principal === 'auth' && event.operation === 'ticket') for (const wake of listeners.get(event.commandId) ?? []) wake();
  });
});
afterEach(async () => { await stop().catch(() => undefined); listeners.clear(); });
const token = 'r'.repeat(43), hash = createHash('sha256').update(token).digest('hex');
describe('F11 held provider completion over committed PostgreSQL capture', () => {
  it.each([['github','https://github.com'],['oidc','https://accounts.google.com']])('%s waits once and completes on its actual committed ticket', async (path, issuer) => {
    const find = vi.spyOn(store, 'findTicket');
    const waiting = app.inject({ method: 'POST', url: `/auth/${path}/completion`, headers: { host: alphaTenant.host }, payload: { recoveryToken: token, waitMs: 1000 } });
    // Fastify inject is a thenable; begin the actual request now.
    const response = Promise.resolve(waiting);
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    const now = new Date();
    await store.createTicket(hash, { challenge: 'c'.repeat(43), community: alphaTenant.community,
      issuer, audience: 'test', subject: 'synthetic-person', createdAt: now, expiresAt: new Date(now.getTime()+120_000),
      attemptCount: 0, consumedAt: null, boundPubkey: null });
    const result = await response;
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ ticket: token, provider: issuer });
    expect(find).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(0);
  });
});
