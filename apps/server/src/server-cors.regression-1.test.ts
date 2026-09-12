import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';

// Regression: ISSUE-001 — the deployed web app could not pass the review-sign-in preflight
// Found by $qa on 2026-09-10
// Report: /home/lunchbox/firstmate2/data/beeline-web-desktop-dogfood/report.md
describe('web app CORS', () => {
  const deployedWebOrigin = 'https://web.usebeeline.app';
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(
    webAppOrigins: readonly string[],
    authHandler?: (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse,
    ) => void,
  ) {
    const redeem = vi.fn().mockResolvedValue({
      status: 'redeemed',
      tokens: { accessToken: 'bat_test', refreshToken: 'brt_test' },
    });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: {} as TokenAuth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      review: { redeem } as never,
      webAppOrigins,
      authHandler,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      redeem,
    };
  }

  it('answers an allowed web app preflight and exposes the review exchange response', async () => {
    const webOrigin = deployedWebOrigin;
    const { origin, redeem } = await start([webOrigin]);
    const preflight = await fetch(`${origin}/v1/auth/review/exchange`, {
      method: 'OPTIONS',
      headers: {
        origin: webOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(webOrigin);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(redeem).not.toHaveBeenCalled();

    const exchange = await fetch(`${origin}/v1/auth/review/exchange`, {
      method: 'POST',
      headers: { origin: webOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'review-secret' }),
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get('access-control-allow-origin')).toBe(webOrigin);
    await expect(exchange.json()).resolves.toEqual({
      accessToken: 'bat_test',
      refreshToken: 'brt_test',
    });
    expect(redeem).toHaveBeenCalledWith('review-secret', '127.0.0.1');
  });

  it('does not grant CORS access to an unlisted browser origin', async () => {
    const { origin, redeem } = await start([deployedWebOrigin]);
    const response = await fetch(`${origin}/v1/auth/review/exchange`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(redeem).not.toHaveBeenCalled();
  });

  it('does not retain the temporary Expo preview as a production origin', async () => {
    const { origin } = await start([deployedWebOrigin]);
    const response = await fetch(`${origin}/v1/auth/review/exchange`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://lunchboxfortwo-buzzy--beeline-desktop-web-workbench-final.expo.app',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows web GitHub completion recovery through the same exact-origin gate', async () => {
    const authHandler = vi.fn((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end('{"status":"pending"}\n');
    });
    const { origin } = await start([deployedWebOrigin], authHandler);

    for (const path of ['/auth/github/completion', '/auth/github/completion/cancel']) {
      const preflight = await fetch(`${origin}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: deployedWebOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(deployedWebOrigin);
    }
    expect(authHandler).not.toHaveBeenCalled();

    const completion = await fetch(`${origin}/auth/github/completion`, {
      method: 'POST',
      headers: { origin: deployedWebOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryToken: 'r'.repeat(43) }),
    });
    expect(completion.status).toBe(202);
    expect(completion.headers.get('access-control-allow-origin')).toBe(deployedWebOrigin);
    expect(authHandler).toHaveBeenCalledTimes(1);
  });
});
