import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { groknight } from './groknight';
import { roomBottomChromeStyles } from './room-bottom-chrome';
import {
  ROOM_OPEN_COMPOSER_BOX_BORDER,
  ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT,
  ROOM_OPEN_INPUT_BAR_BORDER_TOP,
  ROOM_OPEN_INPUT_BAR_PADDING_TOP,
  ROOM_OPEN_LIST_TAIL_PADDING,
  roomOpenBottomChromeHeight,
  roomOpenComposerSafePadding,
  roomOpenMessagePadding,
  roomOpenNewestTextMetrics,
} from './room-open-geometry';

const surface = readFileSync(
  path.join(__dirname, '../app/(app)/beeline/chat/_chat-surface.tsx'),
  'utf8',
);
const composer = readFileSync(
  path.join(__dirname, '../components/buzz/ConversationComposer.tsx'),
  'utf8',
);
const ledger = readFileSync(path.join(__dirname, '../components/buzz/Ledger.tsx'), 'utf8');

describe('Room-open bottom chrome geometry', () => {
  it('mirrors chrome tokens rather than the 26px single-line input height', () => {
    expect(surface).toContain(`paddingVertical: ${ROOM_OPEN_LIST_TAIL_PADDING}`);
    // The composer row is one of the three styles `buzz/room-bottom-chrome.ts`
    // owns, so this reads its actual values rather than the screen's source.
    const composerRow = roomBottomChromeStyles(groknight);
    expect(composerRow.composerRow.paddingTop).toBe(ROOM_OPEN_INPUT_BAR_PADDING_TOP);
    expect(composerRow.composerRow.borderTopWidth).toBe(ROOM_OPEN_INPUT_BAR_BORDER_TOP);
    expect(surface).toContain('inputBar: bottomChrome.composerRow,');
    expect(composer).toContain(`minHeight: ${ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT}`);
    expect(composer).toContain(`borderWidth: ${ROOM_OPEN_COMPOSER_BOX_BORDER}`);
    expect(ledger).toContain('paddingBottom: theme.buzz.messagePaddingVertical * 3,');
    expect(roomOpenMessagePadding()).toBe(groknight.messagePaddingVertical * 3);
    expect(ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT).toBeGreaterThan(26);
    const newest = roomOpenNewestTextMetrics();
    expect(newest.fontFamily).toBe(groknight.proseRegular);
    expect(newest.fontSize).toBe(groknight.proseSize);
    expect(newest.lineHeight).toBe(groknight.proseLineHeight);
    expect(newest.lineHeight).toBe(25);
    expect(ledger).toContain('lineHeight: theme.buzz.proseLineHeight');
  });

  it('reserves list tail + message pad + input bar + composer box + closed-keyboard inset', () => {
    const safeAreaBottom = 48;
    expect(roomOpenComposerSafePadding('android', safeAreaBottom)).toBe(safeAreaBottom + 8);
    expect(roomOpenBottomChromeHeight('android', safeAreaBottom)).toBe(
      ROOM_OPEN_LIST_TAIL_PADDING +
        groknight.messagePaddingVertical * 3 +
        ROOM_OPEN_INPUT_BAR_PADDING_TOP +
        ROOM_OPEN_INPUT_BAR_BORDER_TOP +
        ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT +
        ROOM_OPEN_COMPOSER_BOX_BORDER * 2 +
        safeAreaBottom +
        8,
    );
  });
});
