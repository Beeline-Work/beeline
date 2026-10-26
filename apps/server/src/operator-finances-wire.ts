import type { OperatorFinances } from './operator-finances-contract.js';
import type { OperatorFinancesDetails } from './operator-finances-details.js';

export function unavailableFinances(): OperatorFinances {
  const unknown = () => ({ value: null, source: 'unknown' as const });
  return { month: new Date().toISOString().slice(0, 7), measuredAt: null,
    totals: { mtd: unknown(), projected: unknown(), lastMonth: unknown(), perActiveUser: unknown() },
    daily: [], services: [] };
}

/** The only adaptation to the dashboard's fixed contract; omit collection metadata. */
export function financesWire(details: OperatorFinancesDetails): OperatorFinances {
  type Money = OperatorFinances['totals']['mtd'];
  const unknown = (): Money => ({ value: null, source: 'unknown' });
  const money = (reading: OperatorFinancesDetails['services'][number]['spend']['monthToDate']): Money =>
    reading.usd === null || reading.state === 'stale' ? unknown()
      : { value: reading.usd, source: reading.source === 'API' ? 'api' : reading.source };
  const total = (field: 'monthToDate' | 'projectedMonth' | 'lastMonth'): Money => {
    const reading = details.summary[field];
    if (reading.usd === null) return unknown();
    const sources = new Set(details.services.map(s => money(s.spend[field]).source));
    return { value: reading.usd, source: sources.size === 1 ? [...sources][0]! : 'metered' };
  };
  const services = details.services.map((row): OperatorFinances['services'][number] => {
    const mtd = money(row.spend.monthToDate), lastMonth = money(row.spend.lastMonth);
    const projection = money(row.spend.projectedMonth);
    const projected: Money = projection.value === null ? unknown() : { value: projection.value, source: 'metered' };
    const reading = row.readings.find(r => r.state === 'measured' && r.value === row.balanceUsd);
    const balance = row.billing === 'credits'
      ? row.balanceUsd === null ? { ...unknown(), measuredAt: null, low: false }
        : { value: row.balanceUsd, source: 'api' as const, measuredAt: reading?.measuredAt ?? null, low: reading?.low === true }
      : null;
    const powers = row.spend.monthToDate.state === 'partial'
      ? `${row.powers}. ${row.id === 'openrouter' ? 'Costs cover configured server keys only.'
        : row.id === 'cloudflare' ? 'Costs cover account usage, excluding fixed plans and taxes.' : 'Reported costs cover a subset of usage.'}`
      : row.powers;
    const hasBalance = balance !== null && balance.value !== null;
    return { id: row.id, name: row.name, powers, billing: row.billing, billingUrl: row.billingUrl,
      state: [mtd, projected, lastMonth].some(m => m.value !== null) || hasBalance ? 'ready' : 'unavailable',
      mtd, projected, lastMonth, balance };
  });
  return {
    month: details.month, measuredAt: details.measuredAt,
    totals: { mtd: total('monthToDate'), projected: details.summary.projectedMonth.usd === null ? unknown()
      : { value: details.summary.projectedMonth.usd, source: 'metered' }, lastMonth: total('lastMonth'),
      perActiveUser: unknown() },
    daily: details.daily.map(day => {
      const category = (key: 'models' | 'voice' | 'hosting' | 'other'): Money => {
        if (day[key] === null) return unknown();
        const members = details.services.filter(s => s.category === key);
        const sources = new Set(day.services.filter(s => members.some(m => m.id === s.serviceId))
          .map(s => s.source === 'API' ? 'api' : s.source));
        return { value: day[key], source: sources.size === 1 ? [...sources][0]! : 'metered' };
      };
      return { date: day.date, models: category('models'), voice: category('voice'),
        hosting: category('hosting'), other: category('other') };
    }), services,
  };
}
