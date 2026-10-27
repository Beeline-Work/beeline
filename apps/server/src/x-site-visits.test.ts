import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { dashboardXAds } from './x-ads.js';
import { syncXSiteVisits } from './x-site-visits.js';
import recorded from './x-site-visits.recorded.json';

const now = new Date('2026-10-27T12:00:00Z');
const response = (groups: unknown[]) => ({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: groups }] } }, errors: null });
const group = (refererHost: string, requestPath: string, visits: number, date = '2026-10-25') => ({
  dimensions: { date, refererHost, requestPath }, sum: { visits },
});

describe('daily X site visits (feature, not a defect report)', () => {
  let db: PgliteDatabase;
  beforeEach(async () => { db = new PgliteDatabase(); await migrate(db); });
  afterEach(async () => { await db.close(); vi.unstubAllEnvs(); });
  const send = (payload: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
  async function retry() { await db.query(`UPDATE x_ad_sync SET next_attempt_at=$1 WHERE id='site-visits'`, [now]); }
  async function read() { return (await dashboardXAds(db, now.toISOString())).siteVisits; }

  it('saves recorded Cloudflare visits unchanged and exposes daily estimates in xAds without Ads credentials', async () => {
    const provider = send(recorded);
    await syncXSiteVisits(db, 'fixture-private-token', provider, now);
    expect(provider).toHaveBeenCalledTimes(1);
    const [url, request] = provider.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(request!.headers).toMatchObject({ authorization: 'Bearer fixture-private-token' });
    const query = JSON.parse(request!.body as string).query;
    expect(query).toContain('date_geq:"2026-10-20",date_leq:"2026-10-26"');
    expect(query).toContain('sum{visits}');
    const payload = await read();
    expect(payload).toMatchObject({ state: 'estimated', estimated: true, source: 'cloudflare_web_analytics' });
    expect(payload.daily).toHaveLength(90);
    expect(payload.daily.find(d => d.date === '2026-10-25')).toEqual({ date: '2026-10-25', siteVisits: 256, allSiteVisits: recorded.data.viewer.accounts[0]!.rumPageloadEventsAdaptiveGroups.reduce((sum,g)=>sum+g.sum.visits,0), byAd: [] });
    expect(payload.daily.find(d => d.date === '2026-10-24')!.siteVisits).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('fixture-private-token');
    await syncXSiteVisits(db, 'fixture-private-token', provider, now);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('unions X referrers and ad paths once, attributes paths, and distinguishes observed zero from no data', async () => {
    await syncXSiteVisits(db, 'fixture', send(response([
      group('t.co', '/x/clip', 4), group('', '/x/clip/', 3), group('x.com', '/', 2),
      group('com.twitter.android', '/', 5), group('x.com.evil', '/', 99),
      group('example.com', '/', 40, '2026-10-26'),
    ])), now);
    expect((await read()).daily.find(d => d.date === '2026-10-25')).toEqual({ date: '2026-10-25', siteVisits: 14, allSiteVisits: 113, byAd: [{ adPath: '/x/clip', siteVisits: 7 }] });
    expect((await read()).daily.find(d => d.date === '2026-10-26')).toMatchObject({siteVisits:0,allSiteVisits:40});
    await retry();
    await syncXSiteVisits(db, 'fixture', send(response([group('t.co', '/x/new', 1)])), now);
    expect((await read()).daily.find(d => d.date === '2026-10-25')!.byAd).toEqual([{ adPath: '/x/new', siteVisits: 1 }]);
    expect((await read()).daily.find(d => d.date === '2026-10-26')!.siteVisits).toBeNull();
  });

  it('never uses the voice/billing token and clears availability when analytics token is missing', async () => {
    vi.stubEnv('CLOUDFLARE_ANALYTICS_TOKEN', '');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'voice-only');
    vi.stubEnv('CLOUDFLARE_WORKERS_AI_TOKEN', 'voice-only');
    await syncXSiteVisits(db, 'fixture', send(recorded), now);
    await retry();
    const provider = send(recorded);
    await syncXSiteVisits(db, undefined, provider, now);
    expect(provider).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ state: 'unavailable' });
    expect((await read()).daily.every(d => d.siteVisits === null && d.byAd === null)).toBe(true);
  });

  it.each([
    { ...response([group('t.co', '/', 99)]), errors: [{ message: 'private upstream error' }] },
    { data: { viewer: { accounts: [] } } },
    response([group('t.co', '/', -1)]),
    response([group('t.co', '/', 1, '2026-10-27')]),
    response(Array.from({ length: 10000 }, () => group('t.co', '/', 1))),
  ])('fails closed for invalid, unauthorized or truncated responses without replacing saved data', async payload => {
    await syncXSiteVisits(db, 'fixture', send(recorded), now);
    const saved = (await db.query('SELECT * FROM x_site_visit_daily')).rows;
    await retry();
    await expect(syncXSiteVisits(db, 'fixture', send(payload), now)).rejects.toThrow('Cloudflare site visits unavailable');
    expect((await db.query('SELECT * FROM x_site_visit_daily')).rows).toEqual(saved);
    expect((await read()).daily.every(d => d.siteVisits === null)).toBe(true);
    await retry();
    await syncXSiteVisits(db, 'fixture', send(recorded), now);
    expect((await read()).state).toBe('estimated');
  });

  it('treats HTTP errors, empty data and stale snapshots as unavailable', async () => {
    await expect(syncXSiteVisits(db, 'fixture', vi.fn(async () => new Response('private', {status: 403})), now)).rejects.toThrow('Cloudflare site visits unavailable');
    await retry();
    await syncXSiteVisits(db, 'fixture', send(response([])), now);
    expect((await read()).state).toBe('unavailable');
    expect((await read()).daily.every(d => d.siteVisits === null)).toBe(true);
    await retry();
    await syncXSiteVisits(db, 'fixture', send(recorded), now);
    const stale = (await dashboardXAds(db, '2026-10-29T01:00:00Z')).siteVisits;
    expect(stale.state).toBe('unavailable');
    expect(stale.daily.every(d => d.siteVisits === null)).toBe(true);
  });
});
