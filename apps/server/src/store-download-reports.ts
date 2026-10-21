import { createSign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export type StorePlatform = 'ios' | 'android';
export type DownloadFetcher = (
  platform: StorePlatform,
  days: string[],
  signal: AbortSignal,
) => Promise<Map<string, number>>;
const integer = (s: string | undefined) => {
  if (!s || !/^\d+$/.test(s)) throw new Error('Missing install count');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error('Invalid install count');
  return n;
};
// Quoted CSV and TSV, including embedded separators and CRLF.
function records(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === delimiter || c === '\n')) {
      row.push(cell.replace(/\r$/, ''));
      cell = '';
      if (c === '\n') {
        rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (quoted) throw new Error('Incomplete report');
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}
export function parsePlayReport(bytes: Buffer): Map<string, number> {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const rows = records(bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''), ',');
  const header = rows.shift() ?? [];
  const date = header.indexOf('Date'),
    installs = header.indexOf('Daily User Installs');
  if (date < 0 || installs < 0) throw new Error('Missing Play first-time user installs column');
  const result = new Map<string, number>();
  for (const row of rows.filter((r) => r.some(Boolean))) {
    const day = row[date]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || result.has(day))
      throw new Error('Invalid Play overview day');
    // Recent report rows can exist before Google fills their acquisition count.
    if (row[installs] === undefined || row[installs] === '') continue;
    result.set(day, integer(row[installs]));
  }
  return result;
}
export function parseAppleReport(bytes: Buffer, appId: string, day: string): Map<string, number> {
  const text = (
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: 20_000_000 })
      : bytes
  ).toString('utf8');
  const rows = records(text.replace(/^\uFEFF/, ''), '\t'),
    header = rows.shift() ?? [];
  const type = header.indexOf('Product Type Identifier'),
    units = header.indexOf('Units'),
    app = header.indexOf('Apple Identifier');
  const begin = header.indexOf('Begin Date'),
    end = header.indexOf('End Date');
  if ([type, units, app, begin, end].some((i) => i < 0))
    throw new Error('Invalid Apple sales report');
  const appleDay = `${day.slice(5, 7)}/${day.slice(8)}/${day.slice(0, 4)}`;
  let total = 0;
  for (const row of rows.filter((r) => r.some(Boolean))) {
    if (row[begin] !== appleDay || row[end] !== appleDay)
      throw new Error('Unexpected Apple report date');
    // Exact allowlist excludes update (7*) and re-download (3*) product types.
    if (row[app] === appId && ['1', '1F', '1T'].includes(row[type]!)) total += integer(row[units]);
  }
  if (!Number.isSafeInteger(total)) throw new Error('Invalid Apple total');
  return new Map([[day, total]]);
}
function jwt(header: object, claims: object, key: string, algorithm: 'RSA-SHA256' | 'SHA256') {
  const data = [header, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
    .join('.');
  const signer = createSign(algorithm);
  signer.update(data);
  return `${data}.${signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function checked(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Store HTTP ${response.status}`);
  return response;
}
export function appleNoSales(body: string): boolean {
  try {
    const { errors } = JSON.parse(body) as { errors?: { detail?: unknown }[] };
    return (errors ?? []).some(
      (e) => typeof e.detail === 'string' && /no sales for the date/i.test(e.detail),
    );
  } catch {
    return false;
  }
}
export function storeDownloadFetcher(env: NodeJS.ProcessEnv): DownloadFetcher {
  return async (platform, days, signal) => {
    const now = Math.floor(Date.now() / 1000);
    const output = new Map<string, number>();
    if (platform === 'android') {
      const account = JSON.parse(env.BEELINE_PLAY_SERVICE_ACCOUNT_JSON ?? '{}') as {
        client_email?: string;
        private_key?: string;
      };
      const bucket = env.BEELINE_PLAY_REPORTS_BUCKET,
        pkg = env.BEELINE_PLAY_PACKAGE;
      if (!account.client_email || !account.private_key || !bucket || !pkg)
        throw new Error('Play reports not configured');
      const assertion = jwt(
        { alg: 'RS256', typ: 'JWT' },
        {
          iss: account.client_email,
          scope: 'https://www.googleapis.com/auth/devstorage.read_only',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 300,
        },
        account.private_key,
        'RSA-SHA256',
      );
      const tokenResponse = await checked('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal,
      });
      const token = (await tokenResponse.json()) as { access_token?: string };
      if (!token.access_token) throw new Error('Missing Play access token');
      for (const month of new Set(days.map((d) => d.slice(0, 7).replace('-', '')))) {
        const object = `stats/installs/installs_${pkg}_${month}_overview.csv`;
        const response = await checked(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`,
          { headers: { Authorization: `Bearer ${token.access_token}` }, signal },
        );
        for (const [day, count] of parsePlayReport(Buffer.from(await response.arrayBuffer())))
          if (days.includes(day)) output.set(day, count);
      }
    } else {
      const issuer = env.BEELINE_ASC_ISSUER,
        kid = env.BEELINE_ASC_KEY_ID,
        key = env.BEELINE_ASC_PRIVATE_KEY,
        vendor = env.BEELINE_ASC_VENDOR_NUMBER,
        app = env.BEELINE_ASC_APP_ID;
      if (!issuer || !kid || !key || !vendor || !app)
        throw new Error('Apple reports not configured');
      const token = jwt(
        { alg: 'ES256', kid, typ: 'JWT' },
        { iss: issuer, iat: now, exp: now + 300, aud: 'appstoreconnect-v1' },
        key,
        'SHA256',
      );
      for (const day of days) {
        const query = new URLSearchParams({
          'filter[reportType]': 'SALES',
          'filter[reportSubType]': 'SUMMARY',
          'filter[frequency]': 'DAILY',
          'filter[version]': '1_0',
          'filter[vendorNumber]': vendor,
          'filter[reportDate]': day,
        });
        const response = await fetch(
          `https://api.appstoreconnect.apple.com/v1/salesReports?${query}`,
          { headers: { Authorization: `Bearer ${token}` }, signal },
        );
        // Apple answers 404 both for a day with no sales and for a report not published yet.
        if (response.status === 404 && appleNoSales(await response.text())) {
          output.set(day, 0);
          continue;
        }
        if (!response.ok) throw new Error(`Store HTTP ${response.status}`);
        for (const [date, count] of parseAppleReport(
          Buffer.from(await response.arrayBuffer()),
          app,
          day,
        ))
          output.set(date, count);
      }
    }
    return output;
  };
}
