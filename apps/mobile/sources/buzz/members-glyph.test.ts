import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MEMBERS_LABEL } from './vocabulary';

/** The Workspace menu is the shared mobile and desktop members entry. */
const MENU_ENTRY_POINT = '../components/buzz/WorkspaceActionsMenu.tsx';

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
    for (const relativePath of [MENU_ENTRY_POINT, ...WORD_ENTRY_POINTS]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source, `${relativePath} should spread the shared members word`).toContain(
        'MEMBERS_LABEL',
      );
    }
  });

  it('offers the same named Members action from phone and desktop Workspace menus', () => {
    const menu = readFileSync(new URL(MENU_ENTRY_POINT, import.meta.url), 'utf8');
    const phone = readFileSync(new URL('../app/(app)/beeline/channels.tsx', import.meta.url), 'utf8');
    const desktop = readFileSync(new URL('../components/SidebarView.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('label={MEMBERS_LABEL}');
    expect(menu).toContain('testID="workspace-menu-members"');
    expect(menu).not.toContain('<MembersGlyph');
    expect(phone).toContain('<WorkspaceActionsMenu');
    expect(desktop).toContain('<WorkspaceActionsMenu');
    expect(phone).toContain("pathname: '/beeline/members'");
    expect(desktop).toContain("pathname: '/beeline/members'");
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
    for (const relativePath of [MENU_ENTRY_POINT, ...WORD_ENTRY_POINTS]) {
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
