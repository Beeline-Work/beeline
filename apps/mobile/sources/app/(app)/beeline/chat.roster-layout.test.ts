import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../../components/buzz/RoomRosterSheet.tsx', import.meta.url),
  'utf8',
);
const rowSource = readFileSync(
  new URL('../../../components/buzz/MemberRosterRow.tsx', import.meta.url),
  'utf8',
);
const membersSource = readFileSync(new URL('./MembersScreen.tsx', import.meta.url), 'utf8');
const channelsSource = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');

describe('Room participant roster layout', () => {
  it('bounds the modal content against the viewport before its roster ScrollView is measured', () => {
    const rosterStart = source.indexOf('accessibilityLabel={`Close ${ROOM_LABEL} roster`}');
    const rosterEnd = source.indexOf('testID="room-roster-sheet"', rosterStart);
    const rosterModal = source.slice(rosterStart, rosterEnd);

    expect(rosterStart).toBeGreaterThanOrEqual(0);
    expect(rosterEnd).toBeGreaterThan(rosterStart);
    expect(rosterModal).toContain("maxHeight: '82%'");
    expect(source).toContain(
      "rosterModal: {\n      width: '100%',\n      maxWidth: 460,\n      maxHeight: '100%'",
    );
  });

  it('marks agent state with the tile ring alone: no status square, no kind word (C76)', () => {
    // The ring reads the working record (C77); presence stays in the row's
    // accessibility label without occupying its model-and-owner subtitle.
    expect(source).toContain('alive={agentWorking}');
    expect(source).not.toContain('alive={agentOnline}');
    expect(source).not.toContain("' · online'");
    expect(source).not.toContain("' · offline'");
    expect(source).not.toContain('RosterPresenceLight');
    expect(source).not.toMatch(/'AGENT'|'PERSON'/);
    // Status is still announced once, through the row's accessibility label.
    expect(rowSource).toContain("', online'");
  });

  it('reads in the Members page vocabulary: one word over counted section heads, roles from the type scale', () => {
    expect(source).toContain('{MEMBERS_LABEL}');
    expect(source).toContain('{section.label} {section.options.length}');
    expect(rowSource).toContain('title: { ...Typography.default(), ...hull.type.body');
    expect(rowSource).toContain('subtitle: { ...Typography.default(), ...hull.type.meta');
    expect(rowSource).not.toMatch(/fontSize:\s*\d/);
  });

  it('routes Workspace, Room, and corner member lists through the shared row', () => {
    // The chat-list page opens this Workspace Members route.
    expect(channelsSource).toContain("pathname: '/beeline/members'");
    expect(membersSource).toContain("from '@/components/buzz/MemberRosterRow'");
    expect(membersSource.match(/<MemberRosterRow/g)).toHaveLength(2);

    // Rooms and corners share BuzzChat and RoomRosterSheet. parentChannelId
    // changes management actions only; both member kinds use the shared row.
    expect(source).toContain("from './MemberRosterRow'");
    expect(source.match(/<MemberRosterRow/g)).toHaveLength(2);
    expect(source).toContain('parentChannelId: string | null');
  });
});
