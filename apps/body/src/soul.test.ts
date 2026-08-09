import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSoulServer } from './soul-server.js';
import { generateSoul } from './soul.js';

afterEach(() => vi.restoreAllMocks());

describe('soul generation wiring', () => {
  it('calls the configured OpenAI-compatible egress and parses JSON only', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    name: 'Chrome Warden',
                    personality: 'Keeps the suite green and cuts dead code without ceremony.',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      generateSoul(
        'keep the test suite green and refactor mercilessly',
        {
          OPENAI_COMPAT_API_KEY: 'server-secret',
          OPENAI_COMPAT_BASE_URL: 'https://egress.example/v1',
          OPENAI_COMPAT_MODEL: 'test-model',
          OPENAI_COMPAT_API: 'chat',
        },
        request,
      ),
    ).resolves.toEqual({
      name: 'Chrome Warden',
      personality: 'Keeps the suite green and cuts dead code without ceremony.',
    });
    expect(request).toHaveBeenCalledWith(
      'https://egress.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer server-secret' }),
      }),
    );
  });

  it('serves mobile generation requests without exposing credentials', async () => {
    const generate = vi.fn(async () => ({
      name: 'Spec Cutter',
      personality: 'Ships exact changes.',
    }));
    const server = createSoulServer({ OPENAI_COMPAT_API_KEY: 'never-return-this' }, generate);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/souls/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent: 'ship only what the spec asks for' }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({
        name: 'Spec Cutter',
        personality: 'Ships exact changes.',
      });
      expect(text).not.toContain('never-return-this');
      expect(generate).toHaveBeenCalledWith('ship only what the spec asks for', expect.any(Object));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
