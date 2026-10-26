/** Enter verified recurring invoices here. Null means the operator has not supplied a cost. */
export const fixedMonthlyCosts: readonly {
  serviceId: string; monthlyUsd: number | null; effectiveFrom: string; effectiveThrough: string | null;
  note: string;
}[] = [
  { serviceId: 'apple-developer', monthlyUsd: null, effectiveFrom: '2026-01-01', effectiveThrough: null,
    note: 'Enter the actual annual developer membership invoice divided by 12' },
  { serviceId: 'sentry', monthlyUsd: null, effectiveFrom: '2026-01-01', effectiveThrough: null,
    note: 'Enter the actual monitoring plan invoice; usage overages are not included' },
  { serviceId: 'expo', monthlyUsd: null, effectiveFrom: '2026-01-01', effectiveThrough: null,
    note: 'Enter the actual EAS plan invoice; build overages are not included' },
  { serviceId: 'github', monthlyUsd: null, effectiveFrom: '2026-01-01', effectiveThrough: null,
    note: 'Enter the actual organization plan invoice; Actions overages are not included' },
  { serviceId: 'domains', monthlyUsd: null, effectiveFrom: '2026-01-01', effectiveThrough: null,
    note: 'Enter verified domain renewal invoices amortized per month' },
];
