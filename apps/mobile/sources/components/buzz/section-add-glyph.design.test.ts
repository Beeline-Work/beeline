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
  it('keeps the shared glyph inside a 44pt control', () => {
    const target = header.match(/sectionHeaderAction:\s*\{[\s\S]*?\n\s*\},/);
    expect(target).toBeTruthy();
    expect(target![0]).toContain('minWidth: 44');
    expect(target![0]).toContain('minHeight: 44');
    expect(header).toContain('name="add" size={16}');
  });
});
