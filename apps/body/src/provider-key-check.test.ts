import { describe, expect, it, vi } from 'vitest';
import { verifyProviderKey } from './provider-key-check.js';

function keyResponse(status: number): Response {
  return new Response(status === 200 ? JSON.stringify({ data: [] }) : JSON.stringify({ error: {} }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider key check', () => {
  it('asks the provider for its cheapest authenticated endpoint', async () => {
    const fetchImpl = vi.fn(async () => keyResponse(200));
    await verifyProviderKey({ provider: 'openrouter', apiKey: 'sk-or-real', fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/key');
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-real');
  });

  it('sends the google key as the x-goog-api-key header', async () => {
    const fetchImpl = vi.fn(async () => keyResponse(200));
    await verifyProviderKey({ provider: 'google', apiKey: 'AIza-real', fetchImpl });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com/);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-real');
  });

  it('rejects a refused key with one specific sentence naming the provider and status', async () => {
    for (const [provider, status, label] of [
      ['openrouter', 401, 'OpenRouter'],
      ['openai', 401, 'OpenAI'],
      ['anthropic', 403, 'Anthropic'],
      ['google', 400, 'Google'],
      ['xai', 401, 'xAI'],
    ] as const) {
      await expect(
        verifyProviderKey({ provider, apiKey: 'bogus', fetchImpl: async () => keyResponse(status) }),
      ).rejects.toThrow(`${label} rejected the key (${status}).`);
    }
  });

  it('names the network failure without a stack when the provider is unreachable', async () => {
    await expect(
      verifyProviderKey({
        provider: 'openai',
        apiKey: 'sk-real',
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND api.openai.com\n    at awaiter (node:internal)');
        },
      }),
    ).rejects.toThrow(
      /^Could not reach OpenAI to verify the key \(getaddrinfo ENOTFOUND api\.openai\.com\)\./,
    );
  });

  it('maps a provider outage to a retry sentence instead of a refusal', async () => {
    await expect(
      verifyProviderKey({
        provider: 'anthropic',
        apiKey: 'sk-real',
        fetchImpl: async () => keyResponse(503),
      }),
    ).rejects.toThrow('Anthropic could not verify the key right now (HTTP 503)');
  });
});
