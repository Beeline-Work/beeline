import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The flash is a transient state on an existing row, and the ways it could
 * quietly stop being that — a new colour, a border, a repeat, a mount-time
 * trigger, a highlight on every Room open — are what this file pins.
 */
const flash = readFileSync(path.join(__dirname, 'room-arrival-flash.ts'), 'utf8');
const cell = readFileSync(path.join(__dirname, 'room-message-cell.tsx'), 'utf8');
const surface = readFileSync(
  path.join(__dirname, '../app/(app)/beeline/chat/_chat-surface.tsx'),
  'utf8',
);
const groknight = readFileSync(path.join(__dirname, 'groknight.ts'), 'utf8');

describe('the arrival flash', () => {
  it('CHEV-19: fires on landing completion, never on row mount', () => {
    const completion = surface.slice(
      surface.indexOf('const completePendingNewMessageLanding'),
      surface.indexOf('const observeVisibleTranscriptMessages'),
    );
    // The same success signal the badge settles on: the row is on screen.
    expect(completion).toContain('landingFlashesArrival({');
    expect(completion).toContain('landedBoundaryId: pending.boundaryId');
    expect(completion).toContain('messageAnchorId: messageAnchorIdRef.current');
    expect(completion).toContain('raiseArrivalFlash(pending.boundaryId)');
    // The cell is handed a row id, not a mount hook of its own.
    expect(cell).toContain('arrivalFlashing={messageContainsBoundary(item, arrivalFlashMessageId)}');
    expect(surface).toContain('arrivalFlashMessageId,');
  });

  it('CHEV-19: plays once per landing, and a re-render is not a landing', () => {
    // Mounting is the trigger, and the fill mounts only for the landed row,
    // so a repeat render of a row that is already flashing replays nothing.
    // The surface clears the id on its own timer, so the NEXT landing on the
    // same row is a fresh mount.
    expect(cell).toContain('{flashing ? <ArrivalFlashFill /> : null}');
    expect(cell).toContain('fill.value = withDelay(holdMs, withTiming(0, { duration: fadeMs }));');
    // The cycle depends on nothing that can change under it: a setting
    // toggled mid-flash must not restart the pointer.
    expect(cell).toContain('}, [fill]);');
    expect(cell).not.toMatch(/withRepeat|loop|Infinity/);
    expect(surface).toContain('setArrivalFlashMessageId(null);');
  });

  it('CHEV-22: costs an unflashing row no animation work at all', () => {
    // At most one row in a transcript is ever flashing. Mounting the hooks on
    // every row put reanimated work on every transcript render, which is what
    // the room-view render budget measures.
    const ground = cell.slice(
      cell.indexOf('function ArrivalFlashGround'),
      cell.indexOf('function ArrivalFlashFill'),
    );
    expect(ground).not.toMatch(/useSharedValue|useAnimatedStyle|useReducedMotion|useEffect/);
    // And the slot stays in the tree as null rather than the wrapper coming
    // and going, which would remount the message under it on every pointer.
    expect(ground).toContain(': null}');
  });

  it('CHEV-20: is an area fill in an existing token, with no stroke and no new colour', () => {
    expect(cell).toContain('backgroundColor: theme.buzz.bgHighlight');
    expect(cell).toContain('...StyleSheet.absoluteFillObject');
    // No border, no outline, and no colour literal of its own.
    const ground = cell.slice(
      cell.indexOf('arrivalFlashGround: {'),
      cell.indexOf('newMessages: {'),
    );
    expect(ground).not.toMatch(/border|outline|shadow/i);
    expect(ground).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    // `bgUnread` is defined and contrast-tested but deliberately unused.
    expect(groknight).toContain('bgUnread');
    expect(cell).not.toContain('bgUnread');
    expect(flash).not.toContain('bgUnread');
  });

  it('CHEV-20: leaves the row itself alone while it plays', () => {
    const ground = cell.slice(
      cell.indexOf('function ArrivalFlashGround'),
      cell.indexOf('export function NewMessagesDivider'),
    );
    // Behind the content, out of the accessibility tree, and untouchable: the
    // pointer may not change what the row is or where it sits.
    expect(ground).toContain('pointerEvents="none"');
    expect(ground).toContain('accessibilityElementsHidden');
    expect(ground).toContain('useReducedMotion()');
    expect(ground).not.toMatch(/margin|padding|height:|transform/);
  });
});
