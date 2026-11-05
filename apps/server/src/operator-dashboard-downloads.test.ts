import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { dashboardDownloads } from './operator-dashboard-downloads.js';
import { generateKeyPairSync } from 'node:crypto';
import {
  parseAppleReport,
  parsePlayReport,
  storeDownloadFetcher,
} from './store-download-reports.js';
let db: PgliteDatabase;
const now = '2026-10-20T12:00:00.000Z';
beforeEach(async () => {
  db = await migratedDatabase();
});
afterEach(async () => {
  await db.close();
});
async function cached() {
  await db.query(
    `INSERT INTO store_download_days(platform,day,installs,source,fetched_at,attempted_at,final)
    SELECT 'android',d,10,'Play',$1::timestamptz,$1::timestamptz,true
    FROM generate_series('2026-07-23'::date,'2026-10-18'::date,interval '1 day') d`,
    [now],
  );
}
it('reads cached days without fetching and aligns signup dates to store cutoff', async () => {
  await cached();
  await db.query(
    `INSERT INTO identities(id,kind,name,created_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','human','Person','2026-10-18'),('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','human','Late','2026-10-19')`,
  );
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES ('one','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','android','physical'),('two','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','android','physical')`,
  );
  const fetcher = vi.fn();
  const result = await dashboardDownloads(db, ['android'], now, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    state: 'measured',
    from: '2026-07-23',
    through: '2026-10-18',
    count: 880,
    comparison: { signups: 1, dropOffCount: 879 },
  });
  expect(result.series.weekly.at(-1)?.value).toBe(70);
});
it('fetches only missing days and leases attempts across concurrent refreshes', async () => {
  await cached();
  await db.query(`DELETE FROM store_download_days WHERE day='2026-10-01'`);
  const fetcher = vi.fn(async (_p, days: string[]) => new Map(days.map((d) => [d, 7])));
  const results = await Promise.all([
    dashboardDownloads(db, ['android'], now, fetcher),
    dashboardDownloads(db, ['android'], now, fetcher),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toEqual(['2026-10-01']);
  expect(results.some((r) => r.count === 877)).toBe(true);
});
it('returns missing rather than zero on store failure and throttles failure retries', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error('store offline');
  });
  const result = await dashboardDownloads(db, ['android'], now, fetcher);
  expect(result).toMatchObject({
    state: 'missing',
    count: null,
    comparison: { dropOffCount: null },
  });
  expect(result.series.daily.every((p) => p.value === null)).toBe(true);
  const calls = fetcher.mock.calls.length;
  await dashboardDownloads(db, ['android'], now, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(calls);
});
it('keeps cached values stale when a provisional refresh fails', async () => {
  await cached();
  await db.query(
    `UPDATE store_download_days SET final=false,attempted_at='2026-10-20T10:00Z',fetched_at='2026-10-20T10:00Z' WHERE day='2026-10-18'`,
  );
  const result = await dashboardDownloads(db, ['android'], now, async () => {
    throw new Error('offline');
  });
  expect(result).toMatchObject({ state: 'stale', count: 880 });
});
it('marks web and desktop not measured and never calls stores', async () => {
  const fetcher = vi.fn();
  const result = await dashboardDownloads(db, ['web', 'macos'], now, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect(result).toMatchObject({ state: 'not_measured', count: null });
  expect(result.perPlatform.every((p) => p.state === 'not_measured' && p.count === null)).toBe(
    true,
  );
});
it('parses UTF16 Play first-time users and excludes Apple updates, re-downloads and other apps', () => {
  expect(
    parsePlayReport(
      Buffer.from(
        '\uFEFFDate,Daily User Installs,Daily Device Installs\r\n2026-10-18,7,12\r\n',
        'utf16le',
      ),
    ).get('2026-10-18'),
  ).toBe(7);
  expect(
    parsePlayReport(Buffer.from('Date,Daily User Installs\n2026-10-17,4\n2026-10-18,\n')),
  ).toEqual(new Map([['2026-10-17', 4]]));
  const header = 'Apple Identifier\tProduct Type Identifier\tUnits\tBegin Date\tEnd Date\n';
  const rows = [
    ['42', '1', '2'],
    ['42', '1F', '3'],
    ['42', '1T', '4'],
    ['42', '3F', '19'],
    ['42', '7', '30'],
    ['99', '1', '50'],
  ]
    .map((r) => [...r, '10/18/2026', '10/18/2026'].join('\t'))
    .join('\n');
  expect(parseAppleReport(Buffer.from(header + rows), '42', '2026-10-18').get('2026-10-18')).toBe(
    9,
  );
});
it('counts an Apple no-sales 404 as zero but a not-yet-published 404 as a failure', async () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const fetcher = storeDownloadFetcher({
    BEELINE_ASC_ISSUER: 'issuer',
    BEELINE_ASC_KEY_ID: 'kid',
    BEELINE_ASC_PRIVATE_KEY: key,
    BEELINE_ASC_VENDOR_NUMBER: '1',
    BEELINE_ASC_APP_ID: '42',
  });
  const apple404 = (detail: string) =>
    new Response(JSON.stringify({ errors: [{ status: '404', code: 'NOT_FOUND', detail }] }), {
      status: 404,
    });
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(apple404('There were no sales for the date specified.'))
    .mockResolvedValueOnce(
      apple404('Report is not available yet. Daily reports are available by 5 am Pacific Time.'),
    );
  try {
    const signal = new AbortController().signal;
    expect(await fetcher('ios', ['2026-10-17'], signal)).toEqual(new Map([['2026-10-17', 0]]));
    await expect(fetcher('ios', ['2026-10-18'], signal)).rejects.toThrow('Store HTTP 404');
  } finally {
    fetchMock.mockRestore();
  }
});
