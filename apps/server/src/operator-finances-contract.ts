/** Frozen PR A dashboard contract. Notify the frontend owner before changing this shape. */
type Source = 'API' | 'metered' | 'entered' | 'unknown';
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
export type OperatorFinances = {
  schemaVersion: 1;
  timeZone: 'UTC';
  currency: 'USD';
  measuredAt: string;
  cacheSeconds: number;
  month: string;
  previousMonth: string;
  snapshotState: 'saved' | 'unavailable';
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
    services: { serviceId: string; usd: number | null; source: Source; measuredAt: string | null }[];
  }[];
  perUser: {
    state: 'pending';
    delivery: 'PR B';
    users: [];
    note: string;
  };
  note: string;
};
