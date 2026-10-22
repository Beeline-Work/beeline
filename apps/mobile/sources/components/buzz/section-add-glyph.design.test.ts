import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const members = readFileSync(new URL('../../app/(app)/beeline/members.tsx', import.meta.url), 'utf8');
const roster = readFileSync(new URL('./RoomRosterSheet.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('./RoomListSectionHeader.tsx', import.meta.url), 'utf8');

describe('Shared section add control', () => {
  it('keeps the Members and roster add actions on the common heading', () => {
    expect(members).toContain('<RoomListSectionHeader');
    expect(members).toContain('actionAccessibilityLabel="Add people"');
    expect(members).toContain('actionAccessibilityLabel="Add agents"');
    expect(roster).toContain('<RoomListSectionHeader');
    expect(roster).toContain('actionAccessibilityLabel="Add members"');
  });
  it('keeps a 44pt tap area without growing the heading', () => {
    const target = header.match(/sectionHeaderAction:\s*\{[\s\S]*?\n\s*\},/);
    expect(target).toBeTruthy();
    // The box is one label line tall; the slop, not the box, makes it 44.
    expect(target![0]).toContain('height: LABEL_LINE');
    expect(target![0]).not.toMatch(/min(Height|Width): 44/);
    expect(header).toContain('hitSlop={ACTION_HIT_SLOP}');
    expect(header).toContain('top: (44 - LABEL_LINE) / 2');
    expect(header).toContain('left: (44 - ACTION_GLYPH) / 2');
    expect(header).toContain('name="add" size={ACTION_GLYPH}');
  });
});
