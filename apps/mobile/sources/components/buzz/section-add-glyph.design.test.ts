import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const members = readFileSync(
  new URL('../../app/(app)/beeline/members.tsx', import.meta.url),
  'utf8',
);
const roster = readFileSync(new URL('./RoomRosterSheet.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('./RoomListSectionHeader.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../SidebarView.tsx', import.meta.url), 'utf8');

describe('Shared section add control', () => {
  it('keeps the Members and roster add actions on the common heading', () => {
    expect(members).toContain('<RoomListSectionHeader');
    expect(members).toContain('actionAccessibilityLabel="Add people"');
    expect(members).toContain('actionAccessibilityLabel="Add agents"');
    expect(roster).toContain('<RoomListSectionHeader');
    expect(roster).toContain('actionAccessibilityLabel="Add members"');
  });
  it("uses a full phone target and preserves the desktop tap line", () => {
    const target = header.match(/sectionHeaderAction:\s*\{[\s\S]*?\n\s*\},/);
    expect(target).toBeTruthy();
    // The box is one label line tall; the slop, not the box, makes it 44.
    expect(target![0]).toContain('height: 44');
    expect(target![0]).toContain('width: 44');
    expect(header).toContain('compactAction: { width: ACTION_GLYPH, height: LABEL_LINE }');
    expect(header).toContain('const ACTION_GLYPH = 22');
    expect(target![0]).not.toMatch(/min(Height|Width): 44/);
    expect(header).toContain('hitSlop={tapLineHeight ? ACTION_HIT_SLOP : undefined}');
    expect(header).toContain('top: (44 - LABEL_LINE) / 2');
    expect(header).toContain('left: (44 - ACTION_GLYPH) / 2');
    expect(header).toMatch(/name="add"\s+size={ACTION_GLYPH}/);
    // Only the desktop sidebar keeps main's 44 px line; elsewhere the + adds no height.
    expect(header).toContain("tapLine: { minHeight: 44, justifyContent: 'center' }");
    expect(header).toContain('<View style={tapLineHeight && styles.tapLine}>');
    expect(header).toContain('tapLineHeight = false');
    expect(sidebar).toMatch(/<RoomListSectionHeader[\s\S]*?tapLineHeight[\s\S]*?onAction=/);
  });
});
