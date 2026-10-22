import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MEMBERS_LABEL } from './vocabulary';

const ROOM_ENTRY_POINTS = ['../app/(app)/beeline/chat/_chat-surface.tsx'];

const WORD_ENTRY_POINTS = [
  '../app/(app)/beeline/members.tsx',
  '../components/buzz/WorkspaceSettingsPanel.tsx',
  '../components/buzz/CommunityInviteEntry.tsx',
  '../components/buzz/RoomRosterSheet.tsx',
];

const RETIRED_GLYPH = '⌬';

describe('the members word', () => {
  it('names the destination the same way everywhere, from the shared vocabulary', () => {
    expect(MEMBERS_LABEL).toBe('Members');
    for (const relativePath of WORD_ENTRY_POINTS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should spread the shared members word`).toContain(
        'MEMBERS_LABEL',
      );
    }
  });

  it('offers the same named Members glyph from phone and desktop headers', () => {
    for (const relativePath of ['../app/(app)/beeline/channels.tsx', '../components/SidebarView.tsx']) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).toContain('<MembersAgentsGlyph');
      expect(source).toContain(`accessibilityLabel="${MEMBERS_LABEL}"`);
      expect(source).toContain("pathname: '/beeline/members'");
      expect(source).not.toContain('<WorkspaceActionsMenu');
    }
  });

  it('keeps MembersGlyph off the overflow roster rows and the work pane', () => {
    const chat = readFileSync(new URL(ROOM_ENTRY_POINTS[0], import.meta.url), 'utf8');
    expect(chat.match(/testID="room-participant-roster-trigger"/g)).toHaveLength(1);
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
    for (const relativePath of WORD_ENTRY_POINTS) {
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
