import type { RoomScheduleCadence } from '@beeline/api-contract/phone';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const INTEGER = /^\d+$/;
const STEP = /^\*\/(\d+)$/;

function plural(count: number, unit: string): string {
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `1-5`, `0,6` or `1,3,5` as a set of weekdays (0 and 7 are both Sunday). */
function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.match(/^(\d)(?:-(\d))?$/);
    if (!range) return null;
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);
    if (from > 7 || to > 7 || from > to) return null;
    for (let day = from; day <= to; day += 1) days.add(day % 7);
  }
  return [...days].sort((left, right) => left - right);
}

function dayPhrase(field: string): string | null {
  if (field === '*') return 'Daily';
  const days = weekdays(field);
  if (!days) return null;
  const key = days.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (days.length === 7) return 'Daily';
  const names = days.map((day) => DAYS[day]!);
  return names.length === 1 ? `${names[0]}s` : `Every ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function cronWords(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== '*') return null;
  const minuteStep = minute.match(STEP);
  if (minuteStep && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return plural(Number(minuteStep[1]), 'minute');
  }
  if (!INTEGER.test(minute) || Number(minute) > 59) return null;
  const hourStep = hour.match(STEP);
  if ((hour === '*' || hourStep) && dayOfMonth === '*' && dayOfWeek === '*') {
    const every = plural(hourStep ? Number(hourStep[1]) : 1, 'hour');
    return Number(minute) === 0 ? every : `${every} at :${minute.padStart(2, '0')}`;
  }
  if (!INTEGER.test(hour) || Number(hour) > 23) return null;
  const at = clock(Number(hour), Number(minute));
  if (INTEGER.test(dayOfMonth) && dayOfWeek === '*') {
    return `Monthly on day ${Number(dayOfMonth)} at ${at}`;
  }
  if (dayOfMonth !== '*') return null;
  const days = dayPhrase(dayOfWeek);
  return days ? `${days} at ${at}` : null;
}

/**
 * A schedule's cadence in words a person reads at a glance: `0 8 * * *` is
 * "Daily at 08:00 UTC", not five fields of cron. A clock time names its zone;
 * an expression these words cannot say plainly still shows, marked as custom.
 */
export function scheduleCadenceLabel(cadence: RoomScheduleCadence, nextRun?: Date): string {
  if (cadence.kind === 'interval') {
    const minutes = cadence.everyMinutes;
    if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
    if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
    return plural(minutes, 'minute');
  }
  if (nextRun) {
    const [minute, hour, dom, month, dow] = cadence.expression.trim().split(/\s+/);
    // Fixed daily/weekly clocks can be said in the viewer's zone at the next run.
    // Monthly and irregular expressions retain their source-zone grammar.
    if (INTEGER.test(minute ?? '') && INTEGER.test(hour ?? '') && dom === '*' && month === '*' &&
        (dow === '*' || weekdays(dow ?? ''))) {
      const sourceZone = cadence.timeZone ?? 'UTC';
      const parts = (zone?: string) => new Intl.DateTimeFormat('en-US', {
        timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
      }).formatToParts(nextRun);
      const dayNumber = (zone?: string) => {
        const values = parts(zone);
        const part = (key: string) => Number(values.find(value => value.type === key)?.value);
        return Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000;
      };
      const shift = dayNumber() - dayNumber(sourceZone);
      const days = dow === '*' ? 'Daily' : dayPhrase(weekdays(dow!)!
        .map(day => (day + shift + 7) % 7).join(','));
      const time = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(nextRun);
      const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
        .formatToParts(nextRun).find(part => part.type === 'timeZoneName')?.value ?? '';
      return `${days} at ${time} ${zone}`.trim();
    }
  }
  const words = cronWords(cadence.expression);
  if (!words) return `Custom schedule · ${cadence.expression} ${cadence.timeZone ?? 'UTC'}`;
  return /\d\d:\d\d$/.test(words) ? `${words} ${cadence.timeZone ?? 'UTC'}` : words;
}
