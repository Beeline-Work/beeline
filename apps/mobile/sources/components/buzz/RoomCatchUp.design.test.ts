import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The sheet's scope is the thing most at risk here: it was trimmed from three
 * blocks to two, and the v2 mock's split of decisions from action items is
 * exactly what must not grow back. What a mounted test cannot see — that no
 * third block, filter or control has appeared, and that both doors reach the
 * same sheet — is pinned from source.
 */
const sheet = readFileSync(path.join(__dirname, 'RoomCatchUpSheet.tsx'), 'utf8');
const controls = readFileSync(path.join(__dirname, 'RoomCatchUpControls.tsx'), 'utf8');
const surface = readFileSync(
  path.join(__dirname, '../../app/(app)/beeline/chat/_chat-surface.tsx'),
  'utf8',
);

describe('the catch-up sheet', () => {
  it('CHEV-07: is bottom-anchored with exactly two blocks and no third', () => {
    expect(sheet).toContain('HullActionSheetModal');
    const blockHeads = [...sheet.matchAll(/styles\.blockHead}>([^<]+)</g)].map((match) =>
      match[1]!.trim(),
    );
    expect(blockHeads).toEqual(['Summary', 'Needs you']);
    expect([...sheet.matchAll(/testID="catch-up-sheet-[a-z-]+"/g)].map((match) => match[0])).toEqual(
      ['testID="catch-up-sheet-summary"', 'testID="catch-up-sheet-needs-you"'],
    );
  });

  it('CHEV-07: states the range in the head and carries nothing but dismiss', () => {
    expect(sheet).toContain('subtitle={report.rangeLabel}');
    // Dismissal is the sheet's own; no control of this screen's may be added.
    expect(sheet).not.toContain('Pressable');
    expect(sheet).not.toContain('onJump');
    expect(sheet).not.toContain('footer=');
    expect(sheet).not.toContain('sticky=');
  });

  it('CHEV-08: renders decisions and action items from one list', () => {
    expect(sheet).toContain('report.needsYou.map((item)');
    expect(sheet).toContain('`${item.requesterName} · ${catchUpClock(item.at)}`');
    // The empty test and the one map, and nothing else: a second pass over
    // that array would be the decisions/action-items split coming back.
    expect([...sheet.matchAll(/report\.needsYou/g)]).toHaveLength(2);
    expect(sheet).not.toContain("kind === 'decision'");
    expect(sheet).not.toContain("filter(");
  });

  it('CHEV-09: both doors open that one sheet, and the badge keeps its shortcut', () => {
    expect(controls).toContain('onPress={onOpenCatchUp}');
    expect(controls).toContain('onLongPress={catchUpReachable ? onOpenCatchUp : undefined}');
    expect(controls).toContain("{ name: CATCH_UP_ACCESSIBILITY_ACTION, label: 'Open catch up' }");
    expect(controls).toContain('onAccessibilityAction');
    expect(surface).toContain('onOpenCatchUp={openCatchUpSheet}');
    expect(surface).toContain('<RoomCatchUpSheet');
    // One seam feeds it, and it is handed the range explicitly.
    expect(surface).toContain('buildCatchUpReport({');
    expect(surface).toContain('boundaryId: catchUpBoundaryId');
    expect(surface).toContain('newestId: newestTranscriptMessageId');
  });

  it('CHEV-10: the disc is 44 and its lift stays derived from the turn line', () => {
    expect(controls).toContain('const DISC_SIZE = 44');
    expect(controls).toContain(
      'bottom: 4 + TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM,',
    );
    // The literal that number happens to evaluate to has already moved once.
    expect(controls).not.toMatch(/bottom:\s*\d+,/);
    // A counter capped at 9+, drawn only while it counts something.
    expect(controls).toContain('compactNewMessageCount(badgeCount)');
    expect(controls).toContain('{catchUpReachable && (');
  });

  it('CHEV-12: one module owns catch-up words, and it counts speakers by identity', () => {
    const boundary = readFileSync(
      path.join(__dirname, '../../buzz/room-new-message-boundary.ts'),
      'utf8',
    );
    const report = readFileSync(path.join(__dirname, '../../buzz/room-catch-up-report.ts'), 'utf8');
    // The strip's line and the sheet's blocks are phrased in one place. The
    // boundary module holds queue mechanics and a number formatter, no prose.
    expect(report).toContain('export function catchUpStripLabel');
    expect(boundary).not.toContain('catchUpSummaryText');
    expect(boundary).not.toMatch(/ new message|from \$\{/);
    // Both lines go through the one roll.
    expect([...report.matchAll(/catchUpAuthorRoll\(/g)].length).toBeGreaterThanOrEqual(3);
    // Speakers are distinct by pubkey; name-string dedup collapsed two people
    // who share a display name into one.
    expect(boundary).toContain('other.pubkey === author.pubkey');
    expect(boundary).not.toContain('authorNames');
  });

  it('CHEV-11: no navigation slider grew beside any of it', () => {
    for (const source of [sheet, controls]) {
      expect(source).not.toMatch(/Slider|slider/);
      expect(source).not.toContain('PanResponder');
    }
  });
});
