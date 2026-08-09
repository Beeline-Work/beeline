import { describe, expect, it, vi } from 'vitest';
import { defaultSoul, requestGeneratedSoul } from './soul-generation';

describe('mobile soul generation wiring', () => {
  it('sends only the intent to the server-held generation endpoint', async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          name: 'Chrome Warden',
          personality: 'Keeps the suite green and cuts dead code without ceremony.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      requestGeneratedSoul(
        'http://127.0.0.1:8789/',
        '  keep the test suite green and refactor mercilessly  ',
        request,
      ),
    ).resolves.toEqual({
      name: 'Chrome Warden',
      personality: 'Keeps the suite green and cuts dead code without ceremony.',
    });
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8789/v1/souls/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ intent: 'keep the test suite green and refactor mercilessly' }),
      }),
    );
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/api[_-]?key|bearer|openrouter/i);
  });

  it('uses a stable fast-path default derived from the agent pubkey', () => {
    expect(defaultSoul('abcdef0123456789')).toEqual(defaultSoul('abcdef0123456789'));
    expect(defaultSoul('abcdef0123456789').name).toBe('Agent ABCDEF');
  });
});
