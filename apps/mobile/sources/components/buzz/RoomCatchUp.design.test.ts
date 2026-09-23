import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The unread range is the source for the local overview and the agent request.
 * The two overview blocks keep decisions and action items together; the third
 * block gives the reader an explicit model choice.
 */
const sheet = readFileSync(path.join(__dirname, 'RoomCatchUpSheet.tsx'), 'utf8');
const controls = readFileSync(path.join(__dirname, 'RoomCatchUpControls.tsx'), 'utf8');
const surface = readFileSync(
  path.join(__dirname, '../../app/(app)/beeline/chat/_chat-surface.tsx'),
  'utf8',
);

describe('the catch-up sheet', () => {
  it('offers a model choice below the two overview blocks', () => {
    expect(sheet).toContain('HullActionSheetModal');
    const blockHeads = [...sheet.matchAll(/styles\.blockHead}>([^<]+)</g)].map((match) =>
      match[1]!.trim(),
    );
    expect(blockHeads).toEqual(['Summary', 'Needs you', 'Ask an agent']);
    expect(
      [...sheet.matchAll(/testID="catch-up-sheet-[a-z-]+"/g)].map((match) => match[0]),
    ).toEqual([
      'testID="catch-up-sheet-summary"',
      'testID="catch-up-sheet-needs-you"',
      'testID="catch-up-sheet-agents"',
    ]);
  });

  it('keeps the agent request reachable when the local range has not loaded', () => {
    expect(sheet).toContain("subtitle={report?.rangeLabel ?? 'From your unread point'}");
    expect(sheet).toContain('onPress={() => onAskAgent(agent)}');
    expect(sheet).toContain('Finish your current draft to ask for a catch up.');
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
    expect(sheet).not.toContain('filter(');
  });

  it('CHEV-09: the disc carries the catch-up door, and no bar floats beside it', () => {
    expect(controls).toContain('onLongPress={catchUpReachable ? onOpenCatchUp : undefined}');
    expect(controls).toContain('const catchUpReachable = !corner && catchUpVisible;');
    expect(controls).toContain("{ name: CATCH_UP_ACCESSIBILITY_ACTION, label: 'Open catch up' }");
    expect(controls).toContain('onAccessibilityAction');
    // The strip under the Room header, in every part it was made of. The
    // prose above it may still say why it went; `styles.strip` may not exist.
    expect(controls).not.toContain('catch-up-summary-strip');
    expect(controls).not.toContain('catchUpSummary');
    expect(controls).not.toMatch(/styles\.strip|strip:|stripText/);
    expect(surface).not.toContain('catchUpSummary');
    expect(surface).toContain('onOpenCatchUp={openCatchUpSheet}');
    expect(surface).toContain('<RoomCatchUpSheet');
    // One seam feeds it, and it is handed the range explicitly.
    expect(surface).toContain('buildCatchUpReport({');
    expect(surface).toContain('boundaryId: catchUpBoundaryId');
    expect(surface).toContain('newestId: newestTranscriptMessageId');
    expect(surface).toContain('onAskAgent={draftCatchUpRequest}');
    expect(surface).toContain('selectedAgentMentionsRef.current.set(handle, agent.pubkey)');
  });

  it('CHEV-10: the disc is 44 and its lift stays derived from the turn line', () => {
    expect(controls).toContain('const DISC_SIZE = 44');
    expect(controls).toContain(
      'bottom: 4 + TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM,',
    );
    // The literal that number happens to evaluate to has already moved once.
    expect(controls).not.toMatch(/bottom:\s*\d+,/);
    // A counter capped at 9+, drawn only while it counts something — and on
    // its own count, never on whether catch-up happens to be on offer.
    expect(controls).toContain('compactNewMessageCount(badgeCount)');
    expect(controls).toContain('const badgeShown = !corner && badgeCount > 0;');
    expect(controls).toContain('{badgeShown && (');
  });

  it('CHEV-12: one module owns catch-up words, and it counts speakers by identity', () => {
    const boundary = readFileSync(
      path.join(__dirname, '../../buzz/room-new-message-boundary.ts'),
      'utf8',
    );
    const report = readFileSync(path.join(__dirname, '../../buzz/room-catch-up-report.ts'), 'utf8');
    // The sheet's blocks are phrased in one place. The boundary module holds
    // queue mechanics and a number formatter, no prose.
    expect(report).toContain('export function buildCatchUpReport');
    expect(boundary).not.toContain('catchUpSummaryText');
    expect(boundary).not.toMatch(/ new message|from \$\{/);
    // Speakers are distinct by pubkey; name-string dedup collapsed two people
    // who share a display name into one.
    expect(report).toContain('other.pubkey === author.pubkey');
    expect(boundary).not.toContain('authorNames');
  });

  it('CHEV-15: no catch-up copy states a message count it cannot source', () => {
    const report = readFileSync(path.join(__dirname, '../../buzz/room-catch-up-report.ts'), 'utf8');
    const hook = readFileSync(
      path.join(__dirname, '../../buzz/use-new-message-control.ts'),
      'utf8',
    );
    // The sheet head names the window by its two ends. The live queue is
    // still only a partial view of the run, so nothing else prints a number.
    expect(report).toContain(
      '`Since ${catchUpClock(startedAt)} · newest ${catchUpClock(endedAt)}`',
    );
    expect(report).not.toMatch(/msgs?['`]|\$\{count\}/);
    // The badge keeps its own count, which only ever claims this visit.
    expect(hook).toContain('badgeCount: enabled ? newMessageBadgeCount(queue, newestMessageVisible) : 0');
    expect(hook).not.toContain('unreadCount');
  });

  it('CHEV-16: the offer is gated on the server cursor, not on the live queue', () => {
    const boundary = readFileSync(
      path.join(__dirname, '../../buzz/room-new-message-boundary.ts'),
      'utf8',
    );
    const hook = readFileSync(
      path.join(__dirname, '../../buzz/use-new-message-control.ts'),
      'utf8',
    );
    expect(boundary).toContain('export function catchUpOfferEligible(');
    expect(boundary).not.toMatch(/catchUpOfferEligible[\s\S]{0,200}queue\.count/);
    expect(hook).toContain(
      'catchUpOfferEligible(firstUnreadMessageId, openingUnreadCounts)',
    );
    // And an offer for a run the reader has read is no offer: reaching newest
    // ends it with the glyph that marked the same run.
    expect(hook).toContain('enabled && !boundaryRead && catchUpOfferEligible(');
    // The queue keeps a boundary and a count, and nothing that can be read out.
    expect(boundary).not.toContain('authors: readonly CatchUpAuthor[]');
  });

  it('CHEV-11: no navigation slider grew beside any of it', () => {
    for (const source of [sheet, controls]) {
      expect(source).not.toMatch(/Slider|slider/);
      expect(source).not.toContain('PanResponder');
    }
  });
});
