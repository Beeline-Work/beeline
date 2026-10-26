import type { SqlDatabase } from './database.js';
import { createDashboardServices } from './operator-dashboard-services.js';
import { fixedMonthlyCosts } from './operator-finances-config.js';
import type { OperatorFinances } from './operator-finances-contract.js';

export const OPERATOR_FINANCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS operator_finance_snapshots (
  day date NOT NULL,
  service_id text NOT NULL,
  scope text NOT NULL,
  source text NOT NULL CHECK (source IN ('API','metered','entered')),
  daily_usd double precision,
  month_to_date_usd double precision,
  measured_at timestamptz NOT NULL,
  PRIMARY KEY(day,service_id,scope)
);
`;

type Source = 'API' | 'metered' | 'entered';
type Money = OperatorFinances['services'][number]['spend']['monthToDate'];
type Sample = {
  day: string; service_id: string; scope: string; source: Source;
  daily_usd: number | null; month_to_date_usd: number | null; measured_at: string;
};
type Spend = { monthToDate: Money; projectedMonth: Money; lastMonth: Money };
type Env = Record<string, string | undefined>;
const DAY = 86400000;
const CACHE_MS = 600000;
const unknown = (note: string): Money => ({ usd: null, source: 'unknown', state: 'unknown', measuredAt: null, note });
const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid cost');
  return value;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid list');
  return value;
}
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const monthStart = (time: number, offset = 0) => {
  const d = new Date(time);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
};
const money = (usd: number, source: Source, measuredAt: string, note: string, partial = false): Money =>
  ({ usd, source, state: partial ? 'partial' : 'measured', measuredAt, note });

/** Shared by dashboard reads and the hourly leader collector. Never persists provider bodies. */
export function createOperatorFinances(
  database: SqlDatabase, env: Env = process.env, fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  fixedCosts: typeof fixedMonthlyCosts = fixedMonthlyCosts,
) {
  const balances = createDashboardServices(env, fetchImpl, now);
  let cached: { expires: number; value: Awaited<ReturnType<typeof collect>> } | undefined;
  let pending: Promise<Awaited<ReturnType<typeof collect>>> | undefined;
  async function json(url: string, key: string): Promise<unknown> {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async function collect(): Promise<OperatorFinances> {
    const time = now(), today = isoDay(time), measuredAt = new Date(time).toISOString();
    const start = monthStart(time), priorStart = monthStart(time, -1), trendStart = monthStart(time, -2);
    const elapsedDays = (time - start) / DAY;
    const daysInMonth = (monthStart(time, 1) - start) / DAY;
    const days = Array.from({ length: Math.floor((Date.parse(today) - trendStart) / DAY) + 1 },
      (_, i) => isoDay(trendStart + i * DAY));
    const samples: Sample[] = [];
    const spends = new Map<string, Spend>();
    const missing = (note: string): Spend => ({ monthToDate: unknown(note), projectedMonth: unknown(note), lastMonth: unknown(note) });
    const project = (mtd: Money): Money => mtd.usd === null || elapsedDays <= 0 ? unknown('No elapsed time or spend measurement')
      : { ...mtd, usd: mtd.usd / elapsedDays * daysInMonth,
        note: `${mtd.note}; linear estimate: month-to-date / elapsed UTC days × days in month` };
    const sample = (serviceId: string, scope: string, source: Source, day: string,
      dailyUsd: number | null, monthlyUsd: number | null) => {
      const previous = samples.find(s => s.service_id === serviceId && s.scope === scope && s.day === day);
      if (previous) {
        previous.daily_usd = dailyUsd ?? previous.daily_usd;
        previous.month_to_date_usd = monthlyUsd ?? previous.month_to_date_usd;
        return;
      }
      samples.push({ day, service_id: serviceId, scope, source, daily_usd: dailyUsd,
        month_to_date_usd: monthlyUsd, measured_at: measuredAt });
    };
    const balancePromise = balances();
    const tasks = await Promise.allSettled([
      (async () => {
        const names = ['BEELINE_FREE_AGENT_MODEL_KEY', 'BEELINE_VOICE_OPENROUTER_API_KEY', 'OPENROUTER_EMBEDDING_API_KEY'];
        const keys = [...new Set(names.map(name => env[name]?.trim()).filter((key): key is string => !!key))];
        const customUpstream = env.BEELINE_FREE_AGENT_MODEL_UPSTREAM;
        if (customUpstream && !/^https:\/\/openrouter\.ai(?:\/|$)/.test(customUpstream))
          throw new Error('Free-agent model provider has been overridden');
        if (!keys.length) throw new Error('Missing inference keys');
        const results = await Promise.allSettled(keys.map(async key => {
          const data = object(object(await json('https://openrouter.ai/api/v1/key', key)).data);
          return { monthly: number(data.usage_monthly), daily: number(data.usage_daily) };
        }));
        const fulfilled = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
        if (fulfilled.length !== keys.length) throw new Error('Incomplete key usage');
        const monthly = fulfilled.reduce((sum, r) => sum + r.monthly, 0);
        const daily = fulfilled.reduce((sum, r) => sum + r.daily, 0);
        const scope = 'server-keys';
        sample('openrouter', scope, 'API', today, daily, monthly);
        const mtd = money(monthly, 'API', measuredAt,
          'Configured server inference keys only, deduplicated; helper-owned keys and other account keys are excluded', true);
        spends.set('openrouter', { monthToDate: mtd, projectedMonth: project(mtd),
          lastMonth: unknown('Key API only reports the current UTC month; historical snapshots may cover a subset') });
      })(),
      (async () => {
        const key = env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_AI_TOKEN;
        const account = env.CLOUDFLARE_ACCOUNT_ID;
        if (!key || !account || !/^[a-zA-Z0-9_-]+$/.test(account)) throw new Error('Missing billing credentials');
        const result = object(await json(`https://api.cloudflare.com/client/v4/accounts/${account}/billable-usage?from=${isoDay(trendStart)}&to=${today}`, key));
        if (result.success !== true) throw new Error('Billing read failed');
        const rows = array(result.result).map(object);
        if (!rows.length) throw new Error('No billing coverage');
        let current = 0, previous = 0, hasCurrent = false, hasPrevious = false;
        const daily = new Map<string, number>();
        for (const row of rows) {
          if (row.BillingCurrency !== 'USD') throw new Error('Unsupported currency');
          const cost = number(row.ContractedCost);
          const from = Date.parse(String(row.ChargePeriodStart));
          const through = Date.parse(String(row.ChargePeriodEnd));
          if (!Number.isFinite(from) || !Number.isFinite(through) || through < from) throw new Error('Invalid billing dates');
          // Do not spread a monthly charge over days and call it measured daily spend.
          if (from >= start && from <= time) { current += cost; hasCurrent = true; }
          else if (from >= priorStart && through < start) { previous += cost; hasPrevious = true; }
          const day = isoDay(from);
          if (day === isoDay(through) && day >= days[0]! && day <= today)
            daily.set(day, (daily.get(day) ?? 0) + cost);
        }
        for (const [day, usd] of daily) sample('cloudflare', 'account-billable-usage', 'API', day, usd, null);
        const note = 'Account-wide billable usage; may include other projects; fixed subscriptions and taxes excluded; provider updates daily';
        const mtd = hasCurrent ? money(current, 'API', measuredAt, note, true) : unknown('No current-month billing rows');
        if (hasCurrent) sample('cloudflare', 'account-billable-usage', 'API', today, daily.get(today) ?? null, current);
        spends.set('cloudflare', { monthToDate: mtd, projectedMonth: project(mtd),
          lastMonth: hasPrevious ? money(previous, 'API', measuredAt, note, true) : unknown('No prior-month billing rows') });
      })(),
    ]);
    if (tasks[0]?.status === 'rejected') spends.set('openrouter', missing('OpenRouter key usage unavailable; requires the configured inference keys. Account activity requires a management key'));
    if (tasks[1]?.status === 'rejected') spends.set('cloudflare', missing('Cloudflare billable usage unavailable; requires an account token with Billing Read permission'));

    // The existing budget ledger includes admission reservations: use settled event costs instead.
    // This is a subset fallback, never a second charge added to provider key usage.
    try {
      const { rows } = await database.query<{ day: string; usd: string }>(`
        SELECT (at AT TIME ZONE 'UTC')::date::text AS day,
          sum(CASE WHEN detail->>'usd' ~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
            THEN (detail->>'usd')::numeric ELSE NULL END)::text usd
        FROM free_agent_events WHERE kind='model_usage' AND at >= $1::timestamptz AND at <= $2::timestamptz
        GROUP BY 1 ORDER BY 1`, [isoDay(trendStart), measuredAt]);
      const costs = rows.flatMap(row => {
        const usd = row.usd === null ? NaN : Number(row.usd);
        return Number.isFinite(usd) && usd >= 0 ? [{ day: row.day, usd }] : [];
      });
      for (const row of costs) sample('openrouter', 'free-agent-models', 'metered', row.day, row.usd, null);
      if (spends.get('openrouter')?.monthToDate.usd === null) {
        const thisMonth = costs.filter(row => row.day >= isoDay(start));
        const lastMonth = costs.filter(row => row.day >= isoDay(priorStart) && row.day < isoDay(start));
        const note = 'Estimate from settled free-agent model events only; excludes voice, embeddings and helper models; deleted agents can remove history';
        const mtd = thisMonth.length ? money(thisMonth.reduce((sum, row) => sum + row.usd, 0), 'metered', measuredAt, note, true) : unknown(note);
        spends.set('openrouter', { monthToDate: mtd, projectedMonth: project(mtd),
          lastMonth: lastMonth.length ? money(lastMonth.reduce((sum, row) => sum + row.usd, 0), 'metered', measuredAt, note, true) : unknown(note) });
      }
    } catch { /* Model metering is optional; a failed query must not hide provider data. */ }

    const balanceRows = (await balancePromise).services;
    for (const row of balanceRows) {
      if (spends.has(row.id)) continue;
      const fixed = fixedCosts.filter(cost => cost.serviceId === row.id && cost.monthlyUsd !== null);
      if (row.billing === 'free' || fixed.length) {
        for (const day of days) {
          const configured = fixed.find(cost => day >= cost.effectiveFrom && (!cost.effectiveThrough || day <= cost.effectiveThrough));
          if (row.billing !== 'free' && !configured) continue;
          const d = Date.parse(day), monthDays = (monthStart(d, 1) - monthStart(d)) / DAY;
          sample(row.id, 'fixed-plan', 'entered', day, (configured?.monthlyUsd ?? 0) / monthDays, null);
        }
      }
      spends.set(row.id, missing(fixedCosts.find(c => c.serviceId === row.id)?.note ??
        'No verified spend source with the credentials available to the server'));
    }
    let snapshotState: 'saved' | 'unavailable' = 'saved';
    try {
      if (samples.length) await database.query(`
        INSERT INTO operator_finance_snapshots(day,service_id,scope,source,daily_usd,month_to_date_usd,measured_at)
        SELECT day::date,service_id,scope,source,daily_usd,month_to_date_usd,measured_at::timestamptz
        FROM jsonb_to_recordset($1::jsonb) AS r(day text,service_id text,scope text,source text,
          daily_usd double precision,month_to_date_usd double precision,measured_at text)
        ON CONFLICT(day,service_id,scope) DO UPDATE SET source=EXCLUDED.source,
          daily_usd=COALESCE(EXCLUDED.daily_usd,operator_finance_snapshots.daily_usd),
          month_to_date_usd=COALESCE(EXCLUDED.month_to_date_usd,operator_finance_snapshots.month_to_date_usd),
          measured_at=EXCLUDED.measured_at
        WHERE operator_finance_snapshots.measured_at <= EXCLUDED.measured_at`, [JSON.stringify(samples)]);
    } catch { snapshotState = 'unavailable'; }
    let history: Sample[] = [];
    try {
      history = (await database.query<Sample>(`SELECT day::text,service_id,scope,source,daily_usd,month_to_date_usd,
        measured_at::text FROM operator_finance_snapshots WHERE day >= $1::date AND day <= $2::date ORDER BY day,service_id`,
      [isoDay(trendStart), today])).rows;
    } catch { snapshotState = 'unavailable'; }
    // Fresh data wins when storage failed, so an unavailable DB cannot fabricate or erase provider numbers.
    const merged = new Map(history.map(s => [`${s.day}:${s.service_id}:${s.scope}`, s]));
    for (const s of samples) merged.set(`${s.day}:${s.service_id}:${s.scope}`, s);
    history = [...merged.values()];
    const historyFor = (serviceId: string, day: string) => {
      const rows = history.filter(s => s.service_id === serviceId && s.day === day && s.daily_usd !== null);
      return rows.find(s => s.source === 'API') ?? rows.find(s => s.source === 'metered') ?? rows[0];
    };
    const monthFromDaily = (id: string, from: number, through: number): Money => {
      const dates = days.filter(day => day >= isoDay(from) && day < isoDay(through));
      const observations = dates.map(day => historyFor(id, day));
      if (!dates.length || observations.some(s => !s)) return unknown('Daily history does not cover this entire period');
      const rows = observations as Sample[];
      const latest = rows.map(s => s.measured_at).sort().at(-1)!;
      const source = rows[0]!.source;
      const partial = source !== 'entered';
      return money(rows.reduce((sum, s) => sum + s.daily_usd!, 0), source, latest,
        partial ? 'Observed daily usage only; provider and workload coverage may be partial' : 'Entered fixed monthly plan, allocated evenly across UTC days', partial);
    };
    const services = balanceRows.map((row): OperatorFinances['services'][number] => {
      const spend = spends.get(row.id)!;
      if (row.billing === 'free' || fixedCosts.some(c => c.serviceId === row.id && c.monthlyUsd !== null)) {
        // Fixed costs are accrued through the same fractional UTC day used for the projection.
        const mtd = monthFromDaily(row.id, start, Date.parse(today) + DAY);
        if (mtd.usd !== null) {
          const fullToday = historyFor(row.id, today)?.daily_usd ?? 0;
          mtd.usd -= fullToday * (1 - (time - Date.parse(today)) / DAY);
          spend.monthToDate = mtd;
          spend.projectedMonth = project(mtd);
        }
      }
      if (spend.lastMonth.usd === null) spend.lastMonth = monthFromDaily(row.id, priorStart, start);
      if (spend.monthToDate.usd === null) {
        const last = history.filter(s => s.service_id === row.id && s.day >= isoDay(start) && s.month_to_date_usd !== null)
          .sort((a, b) => b.measured_at.localeCompare(a.measured_at))[0];
        if (last) spend.monthToDate = { usd: last.month_to_date_usd, source: last.source, state: 'stale',
          measuredAt: last.measured_at, note: 'Last saved month-to-date snapshot; refresh unavailable' };
      }
      const category = row.id === 'openrouter' ? 'models' : ['cloudflare', 'groq'].includes(row.id) ? 'voice'
        : ['fly', 'neon', 'tigris'].includes(row.id) ? 'hosting' : 'other';
      const source = (value: Money): 'api' | 'metered' | 'entered' | 'unknown' => value.source === 'API' ? 'api' : value.source;
      const accountCredits = row.readings.filter(r => r.label.endsWith(': account credits') && r.state === 'measured' && r.value !== null);
      const uniqueKeys = new Set(row.envVars.map(name => env[name]?.trim()).filter(Boolean));
      const credit = row.billing === 'credits' && (accountCredits.length === 1 || uniqueKeys.size === 1) ? accountCredits[0] : undefined;
      return { ...row, spend, category,
        billingType: row.billing === 'pay-as-you-go card' ? 'card_monthly' : row.billing === 'fixed plan' ? 'fixed_plan' : row.billing,
        monthToDateUsd: spend.monthToDate.usd, projectedMonthUsd: spend.projectedMonth.usd,
        lastMonthUsd: spend.lastMonth.usd, balanceUsd: credit?.value ?? null,
        sources: { monthToDateUsd: source(spend.monthToDate), projectedMonthUsd: source(spend.projectedMonth),
          lastMonthUsd: source(spend.lastMonth), balanceUsd: credit ? 'api' : 'unknown' },
        readAt: credit?.measuredAt ?? spend.monthToDate.measuredAt,
        error: spend.monthToDate.state === 'unknown' || spend.monthToDate.state === 'stale'
        ? spend.monthToDate.note : row.readings.some(r => r.state === 'unavailable')
          ? 'Some provider balance reads are unavailable; see individual readings' : null };
    });
    const total = (field: keyof Spend): OperatorFinances['summary']['monthToDate'] => {
      const values = services.map(s => s.spend[field]);
      const known = values.filter(v => v.usd !== null);
      return { usd: values.every(v => v.state === 'measured') ? known.reduce((n, v) => n + v.usd!, 0) : null,
        knownUsd: known.length ? known.reduce((n, v) => n + v.usd!, 0) : null,
        measuredServices: known.length, totalServices: values.length,
        state: values.every(v => v.state === 'measured') ? 'measured' : 'partial' };
    };
    return { schemaVersion: 1, timeZone: 'UTC', currency: 'USD', measuredAt, cacheSeconds: CACHE_MS / 1000,
      headline: { monthToDateUsd: total('monthToDate').usd, projectedMonthUsd: total('projectedMonth').usd,
        lastMonthUsd: total('lastMonth').usd, avgCostPerActiveUserUsd: null, activeUsers: null, asOf: measuredAt },
      month: isoDay(start).slice(0, 7), previousMonth: isoDay(priorStart).slice(0, 7), snapshotState,
      summary: { monthToDate: total('monthToDate'), projectedMonth: total('projectedMonth'), lastMonth: total('lastMonth'),
        averageCostPerActiveUser: unknown('Per-user attribution follows in PR B') },
      services,
      daily: days.map(day => {
        const categoryCost = (category: OperatorFinances['services'][number]['category']) => {
          const members = services.filter(s => s.category === category);
          const readings = members.map(s => historyFor(s.id, day));
          return !members.length || readings.some(r => !r) || members.some(s => s.spend.monthToDate.state !== 'measured')
            ? null : readings.reduce((sum, r) => sum + r!.daily_usd!, 0);
        };
        return { date: day, models: categoryCost('models'), voice: categoryCost('voice'),
          hosting: categoryCost('hosting'), other: categoryCost('other'), services: services.map(s => {
        const reading = historyFor(s.id, day);
        return { serviceId: s.id, usd: reading?.daily_usd ?? null, source: reading?.source ?? 'unknown',
          measuredAt: reading?.measured_at ?? null };
      }) }; }),
      perUser: { state: 'pending', delivery: 'PR B', activeUsers: null, attributedShare: null,
        attributedUsd: null, unattributedUsd: null, fixedCostPerActiveUserUsd: null,
        users: [], note: 'Per-user attribution follows in PR B' },
      note: 'Known spend is a subtotal, not total operating cost. Missing history remains null. Snapshots refresh hourly and on dashboard reads.',
    };
  }
  return async () => {
    if (cached && cached.expires > now()) return cached.value;
    pending ??= collect().then(value => { cached = { value, expires: now() + CACHE_MS }; return value; })
      .finally(() => { pending = undefined; });
    return pending;
  };
}

const readers = new WeakMap<SqlDatabase, ReturnType<typeof createOperatorFinances>>();
export function dashboardFinances(database: SqlDatabase) {
  let read = readers.get(database);
  if (!read) { read = createOperatorFinances(database); readers.set(database, read); }
  return read();
}
