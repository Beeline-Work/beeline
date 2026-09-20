import { describe, expect, it } from 'vitest';

import {
  invertedAnchorOffset,
  isLedgerDayOpener,
  LEDGER_DAY_CAPTION_HEIGHT,
  LEDGER_DAY_CAPTION_LINE_HEIGHT,
  LEDGER_DAY_CAPTION_MARGIN,
  ledgerDayCaption,
  measureInvertedTranscript,
  transcriptStamp,
  type LedgerFlowCell,
} from './message-dates';
import { space, typeRoles } from './groknight';

/** Local wall-clock seconds so weekday/date follow the reader's calendar. */
function localSeconds(year: number, month: number, day: number, hour: number, minute: number): number {
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
    expect(transcriptStamp(THU_1658, undefined, SAT_NOW_MS)).toBe('17 SEP 16:58');
  });

  it('keeps later same-day bylines on the clock', () => {
    expect(isLedgerDayOpener(THU_1702, THU_1658)).toBe(false);
    expect(ledgerDayCaption(THU_1702, THU_1658)).toBeNull();
    expect(transcriptStamp(THU_1702, THU_1658, SAT_NOW_MS)).toBe('17:02');
  });

  it('opens today with a caption and a clock-only stamp', () => {
    expect(ledgerDayCaption(SAT_2046, FRI_0228)).toBe('SAT 19 SEP');
    expect(transcriptStamp(SAT_2046, FRI_0228, SAT_NOW_MS)).toBe('20:46');
    expect(transcriptStamp(SAT_2046 + 60, SAT_2046, SAT_NOW_MS)).toBe('20:47');
  });

  it('never says TODAY or YESTERDAY', () => {
    for (const stamp of [
      ledgerDayCaption(THU_1658),
      ledgerDayCaption(FRI_0228, THU_1702),
      ledgerDayCaption(SAT_2046, FRI_0228),
      transcriptStamp(THU_1658, undefined, SAT_NOW_MS),
      transcriptStamp(FRI_0228, THU_1702, SAT_NOW_MS),
      transcriptStamp(SAT_2046, FRI_0228, SAT_NOW_MS),
    ]) {
      expect(stamp).not.toMatch(/TODAY|YESTERDAY/i);
    }
  });

  it('sizes the caption from the type role and spacing scale', () => {
    expect(LEDGER_DAY_CAPTION_LINE_HEIGHT).toBe(typeRoles.sectionHead.lineHeight);
    expect(LEDGER_DAY_CAPTION_MARGIN).toBe(space.md);
    expect(LEDGER_DAY_CAPTION_HEIGHT).toBe(typeRoles.sectionHead.lineHeight + space.md * 2);
  });
});

describe('day caption does not shift the transcript on scroll', () => {
  const thuOpener: LedgerFlowCell = {
    id: 'giselle-1658',
    bodyHeight: 80,
    captionHeight: LEDGER_DAY_CAPTION_HEIGHT,
  };
  const thuLater: LedgerFlowCell = { id: 'you-1702', bodyHeight: 64, captionHeight: 0 };
  const friOpener: LedgerFlowCell = {
    id: 'giselle-0228',
    bodyHeight: 80,
    captionHeight: LEDGER_DAY_CAPTION_HEIGHT,
  };
  const satOpener: LedgerFlowCell = {
    id: 'you-2046',
    bodyHeight: 64,
    captionHeight: LEDGER_DAY_CAPTION_HEIGHT,
  };
  const cellsNewestFirst = [satOpener, friOpener, thuLater, thuOpener];
  const viewportHeight = 360;

  it('keeps list identity equal to message ids — a caption is not its own row', () => {
    expect(cellsNewestFirst.map((cell) => cell.id)).toEqual([
      'you-2046',
      'giselle-0228',
      'you-1702',
      'giselle-1658',
    ]);
  });

  it('holds a later same-day body still when that day’s caption rides the older opener cell', () => {
    const withoutOlderCaption = cellsNewestFirst.map((cell) =>
      cell.id === 'giselle-1658' ? { ...cell, captionHeight: 0 } : cell,
    );
    const pinY = 96;
    const withOffset = invertedAnchorOffset(cellsNewestFirst, 'you-1702', pinY);
    const withoutOffset = invertedAnchorOffset(withoutOlderCaption, 'you-1702', pinY);
    expect(withOffset).toBe(withoutOffset);

    const withCaption = measureInvertedTranscript(cellsNewestFirst, viewportHeight, withOffset);
    const withoutCaption = measureInvertedTranscript(
      withoutOlderCaption,
      viewportHeight,
      withoutOffset,
    );
    const laterWith = withCaption.find((slice) => slice.id === 'you-1702' && slice.kind === 'body');
    const laterWithout = withoutCaption.find(
      (slice) => slice.id === 'you-1702' && slice.kind === 'body',
    );
    expect(laterWith?.viewportY).toBe(pinY);
    expect(laterWithout?.viewportY).toBe(pinY);
    expect(laterWith?.viewportY).toBe(laterWithout?.viewportY);
  });

  it('scrolls the caption with its day-opener instead of pinning it to the viewport', () => {
    const start = invertedAnchorOffset(cellsNewestFirst, 'giselle-1658', 40);
    const before = measureInvertedTranscript(cellsNewestFirst, viewportHeight, start);
    const after = measureInvertedTranscript(cellsNewestFirst, viewportHeight, start + 18);
    const captionBefore = before.find(
      (slice) => slice.id === 'giselle-1658' && slice.kind === 'caption',
    );
    const bodyBefore = before.find((slice) => slice.id === 'giselle-1658' && slice.kind === 'body');
    const captionAfter = after.find(
      (slice) => slice.id === 'giselle-1658' && slice.kind === 'caption',
    );
    const bodyAfter = after.find((slice) => slice.id === 'giselle-1658' && slice.kind === 'body');
    expect(captionBefore).toBeDefined();
    expect(bodyBefore).toBeDefined();
    expect(captionAfter).toBeDefined();
    expect(bodyAfter).toBeDefined();
    const captionDelta = captionAfter!.viewportY - captionBefore!.viewportY;
    const bodyDelta = bodyAfter!.viewportY - bodyBefore!.viewportY;
    expect(captionDelta).toBe(bodyDelta);
    expect(captionDelta).not.toBe(0);
    expect(captionAfter!.viewportY - bodyAfter!.viewportY).toBe(bodyAfter!.height);
  });

  it('never overlays a caption on another message’s body', () => {
    const offset = invertedAnchorOffset(cellsNewestFirst, 'you-1702', 80);
    const visible = measureInvertedTranscript(cellsNewestFirst, viewportHeight, offset);
    const captions = visible.filter((slice) => slice.kind === 'caption');
    const bodies = visible.filter((slice) => slice.kind === 'body');
    for (const caption of captions) {
      for (const body of bodies) {
        if (body.id === caption.id) continue;
        const captionEnd = caption.viewportY + caption.height;
        const bodyEnd = body.viewportY + body.height;
        expect(caption.viewportY < bodyEnd && body.viewportY < captionEnd).toBe(false);
      }
    }
  });
});
