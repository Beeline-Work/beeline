import { describe, expect, it } from 'vitest';
import { databaseConnectionBudget } from './database-budget.js';

describe('database connection budget', () => {
  it('never exceeds the measured capacity across both machines and leaves release headroom', () => {
    const budget = databaseConnectionBudget(25);
    const used = budget.app + budget.enrichment + budget.diagnostics + budget.jobs + budget.listener;
    expect(used).toBeLessThanOrEqual(budget.perMachine);
    expect(used * budget.serverMachines + budget.reservedConnections).toBeLessThanOrEqual(25);
    expect(budget.jobs).toBe(2);
    expect(budget.diagnostics).toBe(1);
    expect(budget.app).toBe(3);
  });

  it('keeps the established pool sizes on a roomy database and caps an app override', () => {
    expect(databaseConnectionBudget(100)).toMatchObject({
      app: 5, enrichment: 2, diagnostics: 1, jobs: 2, listener: 1,
    });
    expect(databaseConnectionBudget(25, 2, 30).app).toBe(3);
  });

  it('fails clearly when even the minimum live and release slots cannot fit', () => {
    expect(() => databaseConnectionBudget(17)).toThrow(/capacity too small/);
    expect(() => databaseConnectionBudget(100, 0)).toThrow(/invalid server machines/);
  });
});
