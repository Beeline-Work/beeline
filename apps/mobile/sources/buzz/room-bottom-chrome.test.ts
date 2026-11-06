import { describe, expect, it } from 'vitest';
import {
  roomBottomChromeStyles,
  TURN_CHROME_COMPOSER_OVERLAP,
  TURN_LABEL_LINE_HEIGHT,
  TURN_LINE_BAR_MARGIN_BOTTOM,
  TURN_LINE_INK_AIR,
  TURN_LINE_ROW_MIN_HEIGHT,
} from './room-bottom-chrome';
import { phoneTranscriptTailPadding } from './room-scroll-follow';

const chrome = roomBottomChromeStyles({ bgTerminal: '#14091A', border: '#291e33' });
const coverage = chrome.turnChromeCoverage;
const translateY = coverage.transform[0].translateY;
const rowHeight = TURN_LINE_ROW_MIN_HEIGHT;
const paddingTop = 'paddingTop' in coverage ? Number(coverage.paddingTop) : 0;
const layoutHeight = paddingTop + rowHeight + TURN_LINE_BAR_MARGIN_BOTTOM + coverage.paddingBottom;
const canvasTop = -layoutHeight + translateY;
const labelTop = canvasTop + paddingTop + (rowHeight - TURN_LABEL_LINE_HEIGHT) / 2;
const labelBottom = labelTop + TURN_LABEL_LINE_HEIGHT;
const fieldTop = chrome.composerRow.paddingTop + chrome.composerRow.borderTopWidth;

describe('phone thinking line and newest transcript row', () => {
  it.each([
    ['plain message', 6],
    ['reaction chips outside the Ledger entry', 0],
    ['card without Ledger padding', 0],
  ])('keeps the entire %s above the canvas', (_name, rowBottomPadding) => {
    const tail = phoneTranscriptTailPadding({ turnChromeVisible: true });
    const newestVisibleBottom = -tail - rowBottomPadding;
    expect(newestVisibleBottom).toBeLessThanOrEqual(canvasTop);
    // No chip margin or Ledger padding is needed to keep the border visible.
    expect(-canvasTop).toBeLessThanOrEqual(tail);
  });

  it('balances visible air against the field border, including composer padding and border', () => {
    const newestRowBottom = -phoneTranscriptTailPadding({ turnChromeVisible: true });
    const upperAir = labelTop - newestRowBottom;
    const lowerAir = fieldTop - labelBottom;
    expect(upperAir).toBe(lowerAir);
    expect(upperAir).toBe(TURN_LINE_INK_AIR);
    expect(fieldTop).toBe(9);
  });

  it('keeps the same tail with and without thinking chrome', () => {
    expect(phoneTranscriptTailPadding({ turnChromeVisible: true })).toBe(36);
    expect(phoneTranscriptTailPadding({ turnChromeVisible: false })).toBe(36);
  });

  it('paints continuously into the opaque composer canvas', () => {
    expect(coverage.backgroundColor).toBe(chrome.stack.backgroundColor);
    expect(chrome.composerRow.backgroundColor).toBe(coverage.backgroundColor);
    expect(chrome.composerRow.borderTopColor).toBe(coverage.backgroundColor);
    expect(translateY).toBeGreaterThanOrEqual(TURN_CHROME_COMPOSER_OVERLAP);
    expect(translateY).toBe(TURN_CHROME_COMPOSER_OVERLAP);
    expect(-canvasTop).toBe(phoneTranscriptTailPadding({ turnChromeVisible: true }));
  });

  it('preserves the shared desktop row and its bottom margin', () => {
    expect(rowHeight).toBe(24);
    expect(TURN_LINE_BAR_MARGIN_BOTTOM).toBe(9);
  });
});
