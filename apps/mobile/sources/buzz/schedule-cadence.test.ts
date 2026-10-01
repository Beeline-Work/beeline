import { describe, expect, it } from 'vitest';
import { scheduleCadenceLabel } from './schedule-cadence';

const cron = (expression: string, timeZone?: string) =>
  scheduleCadenceLabel({ kind: 'cron', expression, ...(timeZone ? { timeZone } : {}) });

describe('scheduleCadenceLabel', () => {
  it('says a daily cron in words with its zone', () => {
    expect(cron('0 8 * * *', 'UTC')).toBe('Daily at 08:00 UTC');
    expect(cron('30 17 * * *', 'America/New_York')).toBe('Daily at 17:30 America/New_York');
    expect(cron('0 8 * * *')).toBe('Daily at 08:00 UTC');
  });

  it('names weekdays, weekends and specific days', () => {
    expect(cron('0 9 * * 1-5')).toBe('Weekdays at 09:00 UTC');
    expect(cron('0 10 * * 0,6')).toBe('Weekends at 10:00 UTC');
    expect(cron('0 10 * * 6,7')).toBe('Weekends at 10:00 UTC');
    expect(cron('15 9 * * 1')).toBe('Every Monday at 09:15 UTC');
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
