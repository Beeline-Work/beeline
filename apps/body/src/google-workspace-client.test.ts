import { describe, expect, it } from 'vitest';
import {
  GoogleApiError,
  YOUTUBE_ANALYTICS_OWNER_LIMIT,
  defaultAnalyticsDateRange,
  googleWorkspaceClient,
  refreshGoogleAccessToken,
  refreshableTokenSource,
  type GoogleApiTransport,
} from './google-workspace-client.js';

function transport(handler: GoogleApiTransport['request']): GoogleApiTransport {
  return { request: handler };
}

describe('defaultAnalyticsDateRange', () => {
  it('returns a UTC 28-day window ending today', () => {
    const range = defaultAnalyticsDateRange(28, new Date('2026-09-18T15:00:00Z'));
    expect(range).toEqual({ startDate: '2026-08-21', endDate: '2026-09-18' });
  });
});

describe('googleWorkspaceClient YouTube', () => {
  it('reads the signed-in channel and an Analytics reports.query', async () => {
    const seen: string[] = [];
    const client = googleWorkspaceClient(
      { accessToken: async () => 'ya29.test' },
      transport(async (method, url) => {
        seen.push(`${method} ${url}`);
        if (url.includes('/youtube/v3/channels')) {
          return {
            status: 200,
            json: {
              items: [
                {
                  id: 'UC1',
                  snippet: { title: 'Bee', customUrl: '@bee' },
                  statistics: { subscriberCount: '3' },
                },
              ],
            },
          };
        }
        if (url.includes('youtubeanalytics.googleapis.com')) {
          expect(url).toContain('ids=channel%3D%3DMINE');
          expect(url).toContain('metrics=views');
          return {
            status: 200,
            json: {
              columnHeaders: [{ name: 'views' }],
              rows: [[42]],
            },
          };
        }
        return { status: 404, json: {} };
      }),
    );
    await expect(client.youtube.getChannel(true)).resolves.toEqual({
      id: 'UC1',
      title: 'Bee',
      handle: '@bee',
      subscriberCount: '3',
    });
    await expect(
      client.youtube.analyticsQuery({ metrics: 'views', startDate: '2026-08-01', endDate: '2026-08-31' }),
    ).resolves.toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      columns: ['views'],
      results: [{ views: 42 }],
      totalRows: 1,
    });
    expect(seen[0]).toContain('youtube/v3/channels');
  });

  it('turns an Analytics 403 into the owner-account limit', async () => {
    const client = googleWorkspaceClient(
      { accessToken: async () => 'ya29.test' },
      transport(async () => ({ status: 403, json: { error: 'forbidden' } })),
    );
    await expect(client.youtube.analyticsQuery({ metrics: 'views' })).rejects.toMatchObject({
      status: 403,
      detail: YOUTUBE_ANALYTICS_OWNER_LIMIT,
    });
  });
});

describe('refreshGoogleAccessToken', () => {
  it('exchanges a refresh token through Beeline’s Google OAuth client', async () => {
    const refreshed = await refreshGoogleAccessToken(
      { accessToken: 'old', refreshToken: 'refresh-1' },
      'client-id',
      'client-secret',
      transport(async (method, url, body) => {
        expect(method).toBe('POST');
        expect(url).toBe('https://oauth2.googleapis.com/token');
        expect(body).toMatchObject({
          client_id: 'client-id',
          refresh_token: 'refresh-1',
          grant_type: 'refresh_token',
        });
        return { status: 200, json: { access_token: 'new-token', expires_in: 3600 } };
      }),
    );
    expect(refreshed.accessToken).toBe('new-token');
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses a grant with no refresh token', async () => {
    await expect(
      refreshGoogleAccessToken({ accessToken: 'only' }, 'id', 'secret', transport(async () => {
        throw new Error('must not call Google');
      })),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe('refreshableTokenSource', () => {
  it('refreshes a stale grant through Beeline’s OAuth client', async () => {
    const source = refreshableTokenSource(
      { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1 },
      'client-id',
      'client-secret',
      transport(async () => ({ status: 200, json: { access_token: 'new-token', expires_in: 3600 } })),
    );
    await expect(source.accessToken()).resolves.toBe('new-token');
  });

  it('keeps a live access token without calling Google', async () => {
    const source = refreshableTokenSource(
      { accessToken: 'live', refreshToken: 'refresh-1', expiresAt: Date.now() + 60_000 },
      'client-id',
      'client-secret',
      transport(async () => {
        throw new Error('must not call Google');
      }),
    );
    await expect(source.accessToken()).resolves.toBe('live');
  });
});
