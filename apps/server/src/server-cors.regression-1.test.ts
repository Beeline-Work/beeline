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
  const deployedWebOrigin =
    'https://lunchboxfortwo-buzzy--beeline-desktop-web-workbench-final.expo.app';
  const servers: ReturnType<typeof createBeelineServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(webAppOrigins: readonly string[]) {
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
});
