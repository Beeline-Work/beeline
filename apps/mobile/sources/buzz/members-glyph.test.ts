import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MEMBERS_LABEL } from './vocabulary';

/**
 * Chrome that opens the members screen next to bookmarks uses the same
 * Ionicons outline family. In-list titles keep the word. The retired hexagon
 * never returns, and no Speakeasy animal stands in for "members" — animals
 * are identity faces.
 */
const CHROME_ENTRY_POINTS = [
  '../app/(app)/beeline/channels.tsx',
  '../components/SidebarView.tsx',
];

const WORD_ENTRY_POINTS = [
  '../app/(app)/beeline/MembersScreen.tsx',
  '../app/(app)/beeline/settings/workspace.tsx',
  '../components/buzz/CommunityInviteEntry.tsx',
  '../components/buzz/RoomRosterSheet.tsx',
];

const RETIRED_GLYPH = '⌬';

describe('the members word', () => {
  it('names the destination the same way everywhere, from the shared vocabulary', () => {
    expect(MEMBERS_LABEL).toBe('Members');
    for (const relativePath of [...CHROME_ENTRY_POINTS, ...WORD_ENTRY_POINTS]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should spread the shared members word`).toContain(
        'MEMBERS_LABEL',
      );
    }
  });

  it('draws the Room-list and desktop heading as an outline people glyph', () => {
    for (const relativePath of CHROME_ENTRY_POINTS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should use the people outline glyph`).toContain(
        'name="people-outline"',
      );
      expect(source, `${relativePath} still paints the members word`).not.toContain(
        'MEMBERS_LABEL.toUpperCase()',
      );
    }
    const phone = readFileSync(new URL(CHROME_ENTRY_POINTS[0], import.meta.url), 'utf8');
    expect(phone).toContain('accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}');
    const desktop = readFileSync(new URL(CHROME_ENTRY_POINTS[1], import.meta.url), 'utf8');
    expect(desktop).toContain('accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}');
    expect(desktop).toContain('testID="desktop-members"');
  });

  it('keeps the retired hexagon and any animal-as-members mark out of every entry', () => {
    for (const relativePath of [...CHROME_ENTRY_POINTS, ...WORD_ENTRY_POINTS]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} still carries the retired members glyph`).not.toContain(
        RETIRED_GLYPH,
      );
      expect(source, `${relativePath} still imports a members glyph constant`).not.toContain(
        'MEMBERS_GLYPH',
      );
    }
  });
});
