/** Fixed wire contract from beeline-dashboard PR 13, commit bafb528, public/finances-data.js. */
type Money = { value: number | null; source: 'api' | 'metered' | 'entered' | 'unknown' };
export type OperatorFinances = {
  month: string;
  measuredAt: string | null;
  totals: { mtd: Money; projected: Money; lastMonth: Money; perActiveUser: Money };
  daily: { date: string; models: Money; voice: Money; hosting: Money; other: Money }[];
  services: {
    id: string;
    name: string;
    powers: string;
    billing: 'credits' | 'pay-as-you-go card' | 'fixed plan' | 'free';
    billingUrl: string;
    state: 'ready' | 'unavailable';
    mtd: Money;
    projected: Money;
    lastMonth: Money;
    balance: (Money & { measuredAt: string | null; low: boolean }) | null;
  }[];
};
