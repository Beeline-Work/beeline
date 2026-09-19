import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { groknight } from './groknight';
import {
  ROOM_OPEN_COMPOSER_BOX_BORDER,
  ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT,
  ROOM_OPEN_INPUT_BAR_BORDER_TOP,
  ROOM_OPEN_INPUT_BAR_PADDING_TOP,
  ROOM_OPEN_LIST_TAIL_PADDING,
  roomOpenBottomChromeHeight,
  roomOpenComposerSafePadding,
  roomOpenMessagePadding,
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
    expect(surface).toContain(`paddingTop: ${ROOM_OPEN_INPUT_BAR_PADDING_TOP}`);
    expect(surface).toContain(`borderTopWidth: ${ROOM_OPEN_INPUT_BAR_BORDER_TOP}`);
    expect(composer).toContain(`minHeight: ${ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT}`);
    expect(composer).toContain(`borderWidth: ${ROOM_OPEN_COMPOSER_BOX_BORDER}`);
    expect(ledger).toContain('paddingBottom: theme.buzz.messagePaddingVertical,');
    expect(roomOpenMessagePadding()).toBe(groknight.messagePaddingVertical);
    expect(ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT).toBeGreaterThan(26);
  });

  it('reserves list tail + message pad + input bar + composer box + closed-keyboard inset', () => {
    const safeAreaBottom = 48;
    expect(roomOpenComposerSafePadding('android', safeAreaBottom)).toBe(safeAreaBottom + 8);
    expect(roomOpenBottomChromeHeight('android', safeAreaBottom)).toBe(
      ROOM_OPEN_LIST_TAIL_PADDING +
        groknight.messagePaddingVertical +
        ROOM_OPEN_INPUT_BAR_PADDING_TOP +
        ROOM_OPEN_INPUT_BAR_BORDER_TOP +
        ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT +
        ROOM_OPEN_COMPOSER_BOX_BORDER * 2 +
        safeAreaBottom +
        8,
    );
  });
});
