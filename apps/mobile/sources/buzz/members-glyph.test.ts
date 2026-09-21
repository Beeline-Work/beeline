import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MEMBERS_LABEL } from './vocabulary';

/**
 * Chrome that opens the members screen next to bookmarks uses MembersGlyph.
 * In-list titles keep the word. The retired hexagon never returns, and no
 * Speakeasy animal stands in for "members" — animals are identity faces.
 */
const CHROME_ENTRY_POINTS = [
  '../app/(app)/beeline/channels.tsx',
  '../components/SidebarView.tsx',
];

const ROOM_ENTRY_POINTS = ['../app/(app)/beeline/chat/_chat-surface.tsx'];

const WORD_ENTRY_POINTS = [
  '../app/(app)/beeline/members.tsx',
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

  it('draws the Room-list and desktop heading as MembersGlyph', () => {
    for (const relativePath of CHROME_ENTRY_POINTS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should use MembersGlyph`).toContain('<MembersGlyph');
      // 16 either written out or named on the surface; what must not drift is
      // the drawn size, since every header mark beside it is the same 16.
      const size = source.match(/<MembersGlyph[\s\S]*?size=\{([A-Za-z_0-9]+)\}/)?.[1];
      expect(size, `${relativePath} should pass MembersGlyph a size`).toBeTruthy();
      const resolved =
        size === '16' ? 16 : Number(source.match(new RegExp(`const ${size} = (\\d+)`))?.[1]);
      expect(resolved, `${relativePath} should keep the 16px chrome size`).toBe(16);
      expect(source, `${relativePath} still paints the members word`).not.toContain(
        'MEMBERS_LABEL.toUpperCase()',
      );
      expect(source, `${relativePath} still uses the retired Ionicons people mark`).not.toContain(
        'people-outline',
      );
    }
    const phone = readFileSync(new URL(CHROME_ENTRY_POINTS[0], import.meta.url), 'utf8');
    expect(phone).toContain('accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}');
    const desktop = readFileSync(new URL(CHROME_ENTRY_POINTS[1], import.meta.url), 'utf8');
    expect(desktop).toContain('accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}');
    expect(desktop).toContain('testID="desktop-members"');
  });

  it('keeps MembersGlyph off the overflow roster rows and the work pane', () => {
    const chat = readFileSync(new URL(ROOM_ENTRY_POINTS[0], import.meta.url), 'utf8');
    expect(chat.match(/testID="room-participant-roster-trigger"/g)).toHaveLength(2);
    expect(chat).not.toContain('MembersGlyph');
    expect(chat).not.toContain('room-participant-roster-glyph');
    const inspector = readFileSync(
      new URL('../components/DesktopRoomInspector.tsx', import.meta.url),
      'utf8',
    );
    expect(inspector).not.toContain('MembersGlyph');
    expect(inspector).not.toContain('title="MEMBERS"');
    expect(inspector).not.toContain('desktop-work-members');
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
