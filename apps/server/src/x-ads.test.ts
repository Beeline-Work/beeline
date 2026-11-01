import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { createBeelineServer } from './server.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';
import { deliverXSignups, dashboardXAds } from './x-ads.js';
import { syncXAdReports, type XAdsGet } from './x-ad-reports.js';

describe('X web attribution user path (feature, not a defect report)', () => {
  let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, base: string;
  beforeEach(async () => {
    db = await migratedDatabase();
    const auth = new TokenAuth(
      db,
      async (ticket) => ({ subject: ticket, login: ticket, name: 'Private customer name' }),
      () => new Date(),
      async (ticket) => ({
        subject: ticket,
        name: 'Private customer name',
        audience: 'fixture',
        email: 'private@example.com',
      }),
    );
    server = createBeelineServer({
      database: db,
      auth,
      phone: {} as PhoneService,
      daemon: {} as DaemonService,
      live: {} as LiveHub,
      mediaMaximumBytes: 1,
      dashboardSecret: 'dashboard-fixture-secret',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    vi.unstubAllEnvs();
  });
  const click = () => ({
    twclid: 'test-click',
    campaignId: 'campaign',
    adId: 'clip',
    adGroupId: 'audience',
    capturedAt: Date.now(),
  });
  async function signup(provider: string, subject: string, xAttribution: unknown = click()) {
    const response = await fetch(`${base}/v1/auth/${provider}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: subject, xAttribution }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const screenRow = (entityId = 'campaign') => ({ level: 'campaign', entityId, name: 'Launch', spend: 10, impressions: 1000, linkClicks: 20 });
  const screen = (payload: unknown, bearer = 'dashboard-fixture-secret') => fetch(`${base}/v1/admin/dashboard/x-ads/screen`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  it('authenticates screen writes and rejects the whole invalid snapshot', async () => {
    const payload = { day: yesterday(), currency: 'USD', rows: [screenRow()] };
    for (const bearer of ['', 'wrong']) expect((await screen(payload, bearer)).status).toBe(403);
    expect((await db.query('SELECT * FROM x_ad_daily')).rows).toEqual([]);
    for (const invalid of [
      { ...payload, day: '0000-01-01' }, { ...payload, day: '2026-02-30' }, { ...payload, day: '9999-01-01' },
      { ...payload, currency: 'usd' }, { ...payload, rows: Array(501).fill(screenRow()) },
      { ...payload, rows: [screenRow(), screenRow()] },
      ...[{entityId: ''}, {name: ' '}, {level: 'audience'}, {spend: -1}, {spend: 0.0000001},
        {spendMicros: 1}, {impressions: 1.5}, {linkClicks: Number.MAX_SAFE_INTEGER + 1}].map(patch =>
        ({ ...payload, rows: [screenRow('valid'), {...screenRow(), ...patch}] })),
    ]) expect((await screen(invalid)).status).toBe(400);
    expect((await db.query('SELECT * FROM x_ad_daily')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM x_ad_sync')).rows).toEqual([]);
  });
  it('shows a screen snapshot with signup cost, replaces retries and becomes stale', async () => {
    await signup('github', 'screen-customer');
    await db.query(`UPDATE x_ad_signups SET created_at=$1::date+interval '1 hour'`, [yesterday()]);
    const payload = { day: yesterday(), currency: 'USD', rows: [screenRow(), screenRow('removed')] };
    expect(await (await screen(payload)).json()).toEqual({written: 2, skipped: 0});
    const next = (await db.query('SELECT next_attempt_at FROM x_ad_sync')).rows[0]!.next_attempt_at;
    payload.rows = [screenRow(),
      {...screenRow('audience'), level: 'ad_group'}, {...screenRow('clip'), level: 'ad'}];
    expect(await (await screen(payload)).json()).toEqual({written: 3, skipped: 0});
    expect((await db.query('SELECT * FROM x_ad_daily')).rows).toHaveLength(3);
    expect((await db.query('SELECT next_attempt_at FROM x_ad_sync')).rows[0]!.next_attempt_at).toEqual(next);
    const response = await fetch(`${base}/v1/admin/dashboard`, {headers: {authorization: 'Bearer dashboard-fixture-secret'}});
    expect(response.status).toBe(200);
    const ads = (await response.json()).xAds;
    expect(ads.adsState).toBe('measured');
    for (const level of ['campaign', 'ad_group', 'ad']) expect(ads.rows).toContainEqual(expect.objectContaining({level, spend: 10, impressions: 1000, linkClicks: 20, signups: 1, costPerSignup: 10}));
    await db.query(`UPDATE x_ad_sync SET completed_at=now()-interval '37 hours'`);
    expect(await dashboardXAds(db, new Date().toISOString())).toMatchObject({adsState: 'stale'});
    expect(await (await screen({...payload, rows: []})).json()).toEqual({written: 0, skipped: 0});
    expect((await db.query('SELECT * FROM x_ad_daily')).rows).toEqual([]);
  });
  it.each(['github', 'google'])(
    'counts a new %s account once across retries and devices and delivers only click data',
    async (provider) => {
      const first = await signup(provider, 'customer');
      const again = await signup(provider, 'customer');
      const device = await signup(provider, 'customer', { ...click(), twclid: 'second-click' });
      expect(first.xSignup).toMatchObject({ eventId: 'tw-rhefr-rhym5' });
      expect(again.xSignup).toBeUndefined();
      expect(device.xSignup).toBeUndefined();
      const rows = (await db.query('SELECT * FROM x_ad_signups')).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        identity_id: first.identityId,
        twclid: 'test-click',
        campaign_id: 'campaign',
        ad_id: 'clip',
        ad_group_id: 'audience',
      });
      const send = vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ data: { conversions_processed: 1 } }), { status: 200 }),
      );
      expect(await deliverXSignups(db, 'fixture-token', send)).toBe(1);
      expect(await deliverXSignups(db, 'fixture-token', send)).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
      const event = JSON.parse(send.mock.calls[0]![1]!.body as string).conversions[0];
      expect(event).toEqual({
        conversion_time: expect.any(String),
        event_id: first.xSignup.eventId,
        conversion_id: first.xSignup.conversionId,
        identifiers: [{ twclid: 'test-click' }],
      });
      expect(JSON.stringify(event)).not.toContain(first.identityId);
      const organic = await signup(provider, 'organic', null);
      await signup(provider, 'organic');
      expect(
        (await db.query('SELECT * FROM x_ad_signups WHERE identity_id=$1', [organic.identityId]))
          .rows,
      ).toEqual([]);
    },
  );
  it('retries rejected/ambiguous delivery with the same conversion ID and never turns a UTM-only visit into an X conversion', async () => {
    const first = await signup('github', 'retry');
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(new Response('{"data":{"conversions_processed":1}}'));
    expect(await deliverXSignups(db, 'fixture', send)).toBe(0);
    expect(await deliverXSignups(db, 'fixture', send)).toBe(0);
    await db.query(`UPDATE x_ad_signups SET next_attempt_at=now()-interval '1 minute'`);
    expect(await deliverXSignups(db, 'fixture', send)).toBe(1);
    for (const call of send.mock.calls)
      expect(JSON.parse(call[1]!.body as string).conversions[0].conversion_id).toBe(
        first.xSignup.conversionId,
      );
    await signup('google', 'utm', { ...click(), twclid: undefined });
    expect(await deliverXSignups(db, 'fixture', send)).toBe(0);
  });
  it('serves daily campaign, clip and audience rows from provider fixtures through the private dashboard', async () => {
    await signup('github', 'dashboard');
    await db.query(
      `UPDATE x_ad_signups SET created_at=date_trunc('day',now() AT TIME ZONE 'UTC')-interval '1 day'+interval '1 hour'`,
    );
    const get: XAdsGet = async <T>(path: string, query?: Record<string, string>) => {
      if (path === 'accounts/fixture') return { data: { currency: 'USD' } } as T;
      if (path.endsWith('/campaigns')) return { data: [{ id: 'campaign', name: 'Launch' }] } as T;
      if (path.endsWith('/line_items'))
        return {
          data: [{ id: 'audience', name: 'Audience handle', campaign_id: 'campaign' }],
        } as T;
      if (path.endsWith('/promoted_tweets'))
        return { data: [{ id: 'clip', tweet_id: 'post', line_item_id: 'audience' }] } as T;
      const metric = (n: number) =>
        Array.from({ length: 168 }, (_, i) =>
          i === 145 && query?.placement === 'ALL_ON_TWITTER' ? n : 0,
        );
      return {
        data: [
          {
            id: query!.entity_ids,
            id_data: [
              {
                segment: null,
                metrics: {
                  impressions: metric(1000),
                  url_clicks: metric(20),
                  billed_charge_local_micro: metric(10_000_000),
                },
              },
            ],
          },
        ],
      } as T;
    };
    expect((await screen({day: yesterday(), currency: 'USD', rows: [screenRow(), screenRow('screen-only')]})).status).toBe(200);
    await db.query(`UPDATE x_ad_sync SET next_attempt_at=now()-interval '1 minute'`);
    await syncXAdReports(db, get, 'fixture');
    expect((await db.query(`SELECT * FROM x_ad_daily WHERE source='screen'`)).rows).toEqual([]);
    const apiRows = (await db.query(`SELECT * FROM x_ad_daily WHERE day=$1 AND entity_id='campaign'`, [yesterday()])).rows;
    expect(apiRows).toHaveLength(1);
    expect(await (await screen({day: yesterday(), currency: 'EUR', rows: [{...screenRow(), spend: 99}]})).json()).toEqual({written: 0, skipped: 1});
    expect((await db.query(`SELECT * FROM x_ad_daily WHERE day=$1 AND entity_id='campaign'`, [yesterday()])).rows).toEqual(apiRows);
    const response = await fetch(`${base}/v1/admin/dashboard`, {
      headers: { authorization: 'Bearer dashboard-fixture-secret' },
    });
    expect(response.status).toBe(200);
    const ads = (await response.json()).xAds;
    expect(ads).toMatchObject({
      scope: 'web signups only',
      adsState: 'measured',
      coverage: { total: 1, attributed: 1, unattributedShare: 0 },
    });
    for (const level of ['campaign', 'ad', 'ad_group'])
      expect(ads.rows).toContainEqual(
        expect.objectContaining({
          level,
          impressions: 1000,
          linkClicks: 20,
          spend: 10,
          signups: 1,
          costPerClick: 0.5,
          costPerSignup: 10,
        }),
      );
    expect(JSON.stringify(ads)).not.toContain('test-click');
    await db.query(`UPDATE x_ad_sync SET next_attempt_at=now()-interval '1 minute'`);
    await expect(
      syncXAdReports(
        db,
        async () => {
          throw new Error('provider unavailable');
        },
        'fixture',
      ),
    ).rejects.toThrow();
    expect(await dashboardXAds(db, new Date().toISOString())).toMatchObject({ adsState: 'stale' });
    const unauthorized = await fetch(`${base}/v1/admin/dashboard`);
    expect(unauthorized.status).toBe(403);
  });
});
