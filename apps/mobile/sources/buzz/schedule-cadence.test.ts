import { describe, expect, it } from 'vitest';
import { scheduleCadenceLabel } from './schedule-cadence';

const cron = (expression: string, timeZone?: string) =>
  scheduleCadenceLabel({ kind: 'cron', expression, ...(timeZone ? { timeZone } : {}) });

describe('scheduleCadenceLabel', () => {
  it('uses the next instant for local clock, day shift and DST', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const cadence = { kind: 'cron' as const, expression: '0 2 * * 0', timeZone: 'UTC' };
      expect(scheduleCadenceLabel(cadence, new Date('2026-10-25T02:00:00Z')))
        .toBe('Saturdays at 22:00 EDT');
      expect(scheduleCadenceLabel(cadence, new Date('2026-11-08T02:00:00Z')))
        .toBe('Saturdays at 21:00 EST');
      expect(scheduleCadenceLabel({ kind: 'cron', expression: '0 8 1 * *', timeZone: 'UTC' },
        new Date('2026-11-01T08:00:00Z'))).toBe('Monthly on day 1 at 08:00 UTC');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('says a daily cron in words with its zone', () => {
    expect(cron('0 8 * * *', 'UTC')).toBe('Daily at 08:00 UTC');
    expect(cron('30 17 * * *', 'America/New_York')).toBe('Daily at 17:30 America/New_York');
    expect(cron('0 8 * * *')).toBe('Daily at 08:00 UTC');
  });

  it('names weekdays, weekends and specific days', () => {
    expect(cron('0 9 * * 1-5')).toBe('Weekdays at 09:00 UTC');
    expect(cron('0 10 * * 0,6')).toBe('Weekends at 10:00 UTC');
    expect(cron('0 10 * * 6,7')).toBe('Weekends at 10:00 UTC');
    expect(cron('15 9 * * 1')).toBe('Mondays at 09:15 UTC');
    expect(cron('0 9 * * 1,3,5')).toBe('Every Monday, Wednesday and Friday at 09:00 UTC');
    expect(cron('0 9 * * 0-6')).toBe('Daily at 09:00 UTC');
  });

  it('says minute and hour steps without a zone', () => {
    expect(cron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cron('0 * * * *')).toBe('Every hour');
    expect(cron('5 * * * *')).toBe('Every hour at :05');
    expect(cron('0 */6 * * *')).toBe('Every 6 hours');
  });

  it('says a monthly day', () => {
    expect(cron('0 8 1 * *')).toBe('Monthly on day 1 at 08:00 UTC');
  });

  it('keeps an expression it cannot say plainly, marked as custom', () => {
    expect(cron('0 8 1-7 * 1')).toBe('Custom schedule · 0 8 1-7 * 1 UTC');
    expect(cron('0 8 * 1 *')).toBe('Custom schedule · 0 8 * 1 * UTC');
  });

  it('says intervals in the largest whole unit', () => {
    expect(scheduleCadenceLabel({ kind: 'interval', everyMinutes: 1 })).toBe('Every minute');
    expect(scheduleCadenceLabel({ kind: 'interval', everyMinutes: 45 })).toBe('Every 45 minutes');
    expect(scheduleCadenceLabel({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
    expect(scheduleCadenceLabel({ kind: 'interval', everyMinutes: 180 })).toBe('Every 3 hours');
    expect(scheduleCadenceLabel({ kind: 'interval', everyMinutes: 1440 })).toBe('Every day');
    expect(scheduleCadenceLabel({ kind: 'interval', everyMinutes: 2880 })).toBe('Every 2 days');
  });
});
