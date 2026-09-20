import { describe, expect, it } from 'vitest';
import {
  isLedgerDayOpener,
  ledgerDayCaption,
  transcriptStamp,
  transcriptBylineOpeners,
} from './message-dates';

/** Local wall-clock seconds so weekday/date follow the reader's calendar. */
function localSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0, 0).getTime() / 1000);
}

const THU_1658 = localSeconds(2026, 9, 17, 16, 58);
const THU_1702 = localSeconds(2026, 9, 17, 17, 2);
const FRI_0228 = localSeconds(2026, 9, 18, 2, 28);
const SAT_2046 = localSeconds(2026, 9, 19, 20, 46);
const SAT_NOW_MS = new Date(2026, 8, 19, 20, 46).getTime();

describe('A+B message dates', () => {
  it('opens a past day with an absolute caption and a dated first byline', () => {
    expect(ledgerDayCaption(THU_1658)).toBe('THU 17 SEP');
    expect(transcriptStamp(THU_1658, true, SAT_NOW_MS)).toBe('17 SEP 16:58');
  });

  it('dates every byline of a past day so the tail still carries the date', () => {
    expect(isLedgerDayOpener(THU_1702, THU_1658)).toBe(false);
    expect(ledgerDayCaption(THU_1702, THU_1658)).toBeNull();
    expect(transcriptStamp(THU_1702, false, SAT_NOW_MS)).toBe('17 SEP 17:02');
  });

  it('opens today with a caption and a clock-only stamp', () => {
    expect(ledgerDayCaption(SAT_2046, FRI_0228)).toBe('SAT 19 SEP');
    expect(transcriptStamp(SAT_2046, true, SAT_NOW_MS)).toBe('20:46');
    expect(transcriptStamp(SAT_2046 + 60, false, SAT_NOW_MS)).toBe('20:47');
  });

  it('never says TODAY or YESTERDAY', () => {
    for (const stamp of [
      ledgerDayCaption(THU_1658),
      ledgerDayCaption(FRI_0228, THU_1702),
      ledgerDayCaption(SAT_2046, FRI_0228),
      transcriptStamp(THU_1658, true, SAT_NOW_MS),
      transcriptStamp(FRI_0228, true, SAT_NOW_MS),
      transcriptStamp(SAT_2046, true, SAT_NOW_MS),
    ]) {
      expect(stamp).not.toMatch(/TODAY|YESTERDAY/i);
    }
  });

  it('dates the first byline after notices, cards, and activity without repeating it', () => {
    const row = { text: '', isUser: false, timestamp: THU_1658 };
    expect([
      ...transcriptBylineOpeners([
        { ...row, id: 'notice', isSystemNotice: true },
        { ...row, id: 'card', roomUpdate: {} },
        { ...row, id: 'activity', isAgentActivity: true },
        { ...row, id: 'first' },
        { ...row, id: 'intervening', isSystemNotice: true },
        { ...row, id: 'later', timestamp: THU_1702 },
        { ...row, id: 'today-notice', timestamp: SAT_2046, isSystemNotice: true },
        { ...row, id: 'today', timestamp: SAT_2046 },
      ]),
    ]).toEqual(['first', 'today']);
  });
});
