import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { createBeelineServer } from './server.js';
import { dashboardXSiteVisits } from './x-site-visits.js';
import { dashboardSiteDownloadTaps } from './site-download-taps.js';

describe('first-party download tap aggregates', () => {
  let db: PgliteDatabase;
  let server: ReturnType<typeof createBeelineServer>;
  let base: string;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    server = createBeelineServer({
      database: db,
      auth: new TokenAuth(db, async (subject) => ({ subject, login: subject })),
      phone: {} as never,
      daemon: {} as never,
      live: {} as never,
      mediaMaximumBytes: 1,
      webAppOrigins: ['https://evil.example'],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1/site/download-tap`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });
  const post = (body: unknown, origin = 'https://usebeeline.app') =>
    fetch(base, {
      method: 'POST',
      headers: { origin, 'content-type': 'text/plain' },
      body: JSON.stringify(body),
    });
  it('increments only daily platform/source aggregates and caps each row', async () => {
    for (const platform of ['ios', 'android', 'macos', 'windows', 'linux'])
      for (const source of ['x', 'organic']) {
        expect((await post({ platform, source })).status).toBe(204);
        expect((await post({ platform, source })).status).toBe(204);
      }
    const rows = (
      await db.query(
        `SELECT *,day=(now() AT TIME ZONE 'UTC')::date AS today FROM site_download_tap_daily`,
      )
    ).rows;
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => Number(r.taps) === 2 && r.today)).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(['day', 'platform', 'source', 'taps', 'today']);
    await db.query(
      `UPDATE site_download_tap_daily SET taps=99999 WHERE platform='ios' AND source='x'`,
    );
    expect((await post({ platform: 'ios', source: 'x' })).status).toBe(204);
    expect((await post({ platform: 'ios', source: 'x' })).status).toBe(429);
    expect(
      Number(
        (
          await db.query(
            `SELECT taps FROM site_download_tap_daily WHERE platform='ios' AND source='x'`,
          )
        ).rows[0]!.taps,
      ),
    ).toBe(100000);
  });
  it('rejects malformed bodies without writes and isolates CORS from other API origins', async () => {
    for (const input of [
      null,
      [],
      {},
      { platform: 'web', source: 'x' },
      { platform: 'ios', source: 'ad' },
      { platform: 'ios', source: 'x', twclid: 'not-stored' },
      { platform: 1, source: 'organic' },
    ]) {
      expect((await post(input)).status).toBe(400);
    }
    const invalid = await fetch(base, {
      method: 'POST',
      headers: { origin: 'https://usebeeline.app' },
      body: '{',
    });
    expect(invalid.status).toBe(400);
    for (const origin of ['https://evil.example', 'https://web.usebeeline.app', 'null', '']) {
      const response = await post({ platform: 'ios', source: 'x' }, origin);
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    const preflight = await fetch(base, {
      method: 'OPTIONS',
      headers: { origin: 'https://usebeeline.app' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://usebeeline.app');
    expect((await db.query('SELECT * FROM site_download_tap_daily')).rows).toHaveLength(0);
  });
  it('compares complete weeks, includes platform/source totals, and leaves unavailable visit rates null', async () => {
    const now = '2026-10-27T12:00:00Z';
    await db.query(
      `INSERT INTO site_download_tap_daily VALUES('2026-10-26','android','x',4),('2026-10-26','ios','organic',6),('2026-10-19','linux','organic',2),('2026-10-27','ios','organic',50)`,
    );
    await db.query(`INSERT INTO x_ad_sync(id,completed_at) VALUES('site-visits',$1)`, [now]);
    await db.query(`INSERT INTO x_site_visit_daily(day,site_visits,all_site_visits)
      SELECT day,20,100 FROM generate_series('2026-10-13'::date,'2026-10-26'::date,interval '1 day') day`);
    const read = async () =>
      dashboardSiteDownloadTaps(db, now, await dashboardXSiteVisits(db, now));
    const result = await read();
    expect(result.daily).toHaveLength(90);
    expect(result.last7).toMatchObject({
      total: 10,
      x: 4,
      organic: 6,
      allSiteVisits: 700,
      xSiteVisits: 140,
      allVisitToTapRate: 10 / 700,
      xVisitToTapRate: 4 / 140,
    });
    expect(result.prior7.total).toBe(2);
    expect(
      result.last7.counts.find((r) => r.platform === 'android' && r.source === 'x')!.taps,
    ).toBe(4);
    expect(result.daily.at(-1)!.total).toBe(50);
    expect(result.daily.at(-1)!.allVisitToTapRate).toBeNull();
    await db.query(`UPDATE x_ad_sync SET failed_at=$1 WHERE id='site-visits'`, [now]);
    expect((await read()).last7).toMatchObject({
      total: 10,
      allVisitToTapRate: null,
      xVisitToTapRate: null,
    });
  });
});
