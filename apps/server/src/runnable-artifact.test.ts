import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { runnableOrigin, RUNNABLE_CSP, serveRunnableArtifact } from './runnable-artifact.js';
import type { ObjectService } from './object-service.js';

describe('runnable artifact host', () => {
  it('keeps the production listener reachable by the games edge over Fly private IPv6', () => {
    const config = readFileSync(new URL('../../../fly.beeline-server.toml', import.meta.url), 'utf8');
    const env = config.split(/^\[env\]\s*$/m)[1]?.split(/^\[/m)[0];
    // The games edge resolves beeline-server.internal to IPv6-only 6PN addresses.
    expect(env).toMatch(/^\s*HOST\s*=\s*"::"\s*$/m);
  });
  it('requires a separate registrable HTTPS site, including private suffixes', () => {
    for (const origin of [
      'https://usebeeline.app',
      'https://games.usebeeline.app',
      'http://games.example.net',
      'https://app.example.org/path',
      'https://app.example.org',
    ]) {
      expect(() =>
        runnableOrigin({ BEELINE_GAME_ORIGIN: origin, PUBLIC_ORIGIN: 'https://app.example.org' }),
      ).toThrow();
    }
    expect(
      runnableOrigin({
        BEELINE_GAME_ORIGIN: 'https://beeline-games.fly.dev',
        PUBLIC_ORIGIN: 'https://beeline-server.fly.dev',
      }),
    ).toBe('https://beeline-games.fly.dev');
    expect(runnableOrigin({})).toBe('https://beeline-games.fly.dev');
  });
  it('serves only capability-addressed HTML with sandbox and offline headers', async () => {
    let calls = 0;
    const objects = {
      openRunnableArtifact: async (_id: string, _expires: number, token: string) => {
        calls++;
        return token === 'valid' ? Buffer.from('<script>game()</script>') : undefined;
      },
    } as unknown as ObjectService;
    const server = createServer((req, res) => {
      void serveRunnableArtifact(req, res, 'https://games.example.net', objects);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const response = await fetch(
        `${base}/play/11111111-1111-4111-8111-111111111111?expires=123&token=valid`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(RUNNABLE_CSP);
      expect(RUNNABLE_CSP).not.toContain('allow-same-origin');
      expect(response.headers.get('permissions-policy')).toContain('microphone=()');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).toBe('<script>game()</script>');
      const embedded = await fetch(
        `${base}/play/11111111-1111-4111-8111-111111111111?expires=123&token=valid&embed=1`,
      );
      const shell = await embedded.text();
      expect(shell).not.toContain('<script>game()</script>');
      expect(shell).toContain(Buffer.from('<script>game()</script>').toString('base64'));
      expect(shell).toContain('event.source !== parent');
      expect(shell).toContain("event.data !== 'beeline-start-game'");
      expect((await fetch(`${base}/v1/phone/identity`)).status).toBe(404);
      expect(calls).toBe(2);
      expect(
        (await fetch(`${base}/play/11111111-1111-4111-8111-111111111111?token=bad`)).status,
      ).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
