/** Internal collection details; the public dashboard shape is operator-finances-contract.ts. */
type Source = 'API' | 'metered' | 'entered' | 'unknown';
type NumberSource = 'api' | 'metered' | 'entered' | 'unknown';
type Money = {
  usd: number | null;
  source: Source;
  state: 'measured' | 'partial' | 'stale' | 'unknown';
  measuredAt: string | null;
  note: string;
};
type Total = {
  usd: number | null;
  knownUsd: number | null;
  measuredServices: number;
  totalServices: number;
  state: 'measured' | 'partial';
};
export type OperatorFinancesDetails = {
  schemaVersion: 1;
  timeZone: 'UTC';
  currency: 'USD';
  measuredAt: string;
  cacheSeconds: number;
  month: string;
  previousMonth: string;
  snapshotState: 'saved' | 'unavailable';
  headline: {
    monthToDateUsd: number | null;
    projectedMonthUsd: number | null;
    lastMonthUsd: number | null;
    avgCostPerActiveUserUsd: number | null;
    activeUsers: number | null;
    asOf: string | null;
  };
  summary: {
    monthToDate: Total;
    projectedMonth: Total;
    lastMonth: Total;
    averageCostPerActiveUser: Money;
  };
  services: {
    id: string;
    name: string;
    powers: string;
    category: 'models' | 'voice' | 'hosting' | 'other';
    billingType: 'credits' | 'card_monthly' | 'fixed_plan' | 'free';
    monthToDateUsd: number | null;
    projectedMonthUsd: number | null;
    lastMonthUsd: number | null;
    /** Only a single unambiguous account-credit reading; never summed across keys. */
    balanceUsd: number | null;
    sources: {
      monthToDateUsd: NumberSource;
      projectedMonthUsd: NumberSource;
      lastMonthUsd: NumberSource;
      balanceUsd: NumberSource;
    };
    readAt: string | null;
    envVars: string[];
    billing: 'credits' | 'pay-as-you-go card' | 'fixed plan' | 'free';
    billingUrl: string;
    balanceNote: string;
    state: 'measured' | 'unavailable' | 'no_balance_api';
    balanceHealth: 'low' | 'unreadable' | 'ok' | 'not_applicable';
    /** Fixed, sanitized explanation; never a provider error body. */
    error: string | null;
    readings: {
      label: string;
      /** Fixed endpoint URL, without credentials or account identifiers. */
      source: string;
      state: 'measured' | 'unavailable';
      value: number | null;
      unit: 'USD';
      /** Time this balance was read (readAt), not the dashboard request time. */
      measuredAt: string | null;
      low: boolean | null;
      note: string | null;
    }[];
    spend: { monthToDate: Money; projectedMonth: Money; lastMonth: Money };
  }[];
  daily: {
    date: string;
    models: number | null;
    voice: number | null;
    hosting: number | null;
    other: number | null;
    services: { serviceId: string; usd: number | null; source: Source; measuredAt: string | null }[];
  }[];
  perUser: {
    state: 'pending' | 'measured' | 'partial' | 'unavailable';
    delivery: 'PR B';
    activeUsers: number | null;
    attributedShare: number | null;
    attributedUsd: number | null;
    unattributedUsd: number | null;
    fixedCostPerActiveUserUsd: number | null;
    users: {
      handle: string;
      modelsUsd: number | null;
      voiceUsd: number | null;
      machineUsd: number | null;
      variableUsd: number | null;
      fixedUsd: number | null;
      totalUsd: number | null;
    }[];
    note: string;
  };
  note: string;
};
