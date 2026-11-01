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
  it('keeps Workspace Members add actions on the common section heading', () => {
    expect(members).toContain('<RoomListSectionHeader');
    expect(members).toContain('actionAccessibilityLabel="Add people"');
    expect(members).toContain('actionAccessibilityLabel="Add agents"');
  });
  it('puts the Room add action beside Close without a separate count heading', () => {
    expect(roster).not.toContain('<RoomListSectionHeader');
    const heading = roster.slice(roster.indexOf('<View style={styles.rosterModalHeading}>'), roster.indexOf('<ScrollView'));
    expect(heading).toContain('{canAddMembers && (');
    expect(roster).toContain("import { SectionAddButton } from './RoomListSectionHeader'");
    expect(heading).toContain('<SectionAddButton');
    expect(heading).not.toContain('label="Add"');
    expect(heading).toContain('accessibilityLabel="Add members"');
    expect(heading).toContain('onPress={onAddMembers}');
    expect(heading).toContain('onPress={onClose}');
    expect(heading).not.toContain('members.length');
  });
  it("uses a full phone target and preserves the desktop tap line", () => {
    const target = header.match(/sectionHeaderAction:\s*\{[\s\S]*?\n\s*\},/);
    expect(target).toBeTruthy();
    // Phones use a 44px box; desktop keeps its compact glyph plus hit slop.
    expect(target![0]).toContain('height: 44');
    expect(target![0]).toContain('width: 44');
    expect(header).toContain('compactAction: { width: ACTION_GLYPH, height: ACTION_GLYPH }');
    expect(header).toContain('const ACTION_GLYPH = 24');
    expect(target![0]).not.toMatch(/min(Height|Width): 44/);
    expect(header).toContain('<SectionAddButton');
    expect(header).toContain('compact={tapLineHeight}');
    expect(header).toContain('hitSlop={compact ? ACTION_HIT_SLOP : undefined}');
    expect(header).toContain('top: (44 - ACTION_GLYPH) / 2');
    expect(header).toContain('left: (44 - ACTION_GLYPH) / 2');
    // Only the desktop sidebar keeps main's 44 px line; elsewhere the + adds no height.
    expect(header).toContain("tapLine: { minHeight: 44, justifyContent: 'center' }");
    expect(header).toContain('<View style={tapLineHeight && styles.tapLine}>');
    expect(header).toContain('tapLineHeight = false');
    expect(sidebar).toMatch(/<RoomListSectionHeader[\s\S]*?tapLineHeight[\s\S]*?onAction=/);
  });
  it('draws a bold, round-capped plus in the accent color', () => {
    // The thin Ionicons stroke was hard to see.
    expect(header).not.toContain('Ionicons');
    expect(header).toContain('const ACTION_STROKE = 2.4');
    expect(header).toContain('strokeWidth={ACTION_STROKE}');
    expect(header).toContain('strokeLinecap="round"');
    expect(header).toContain('<Path d="M12 5v14M5 12h14" />');
    expect(header).toContain('<SectionAddGlyph color={styles.sectionHeaderActionGlyph.color} />');
    expect(header).toContain('sectionHeaderActionGlyph: { color: hull.accent }');
  });
});
