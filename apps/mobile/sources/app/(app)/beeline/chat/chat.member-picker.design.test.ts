import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source contract for the "Add people or Agents" picker (captain report C57,
 * v0.0.36): a percent `maxHeight` on a centered floating surface resolves
 * against the modal wrapper's own auto height, so the inner ScrollView
 * shrank to a fraction of its content and clipped after the first row. The
 * cap belongs on `HullModal`'s `contentStyle` (its parent is the flex:1
 * modal root), and the surface fills that wrapper — the same shape
 * `RoomRosterSheet.tsx` uses.
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');

function pickerMarkup(): string {
  const marker = chatSource.indexOf('testID="room-member-picker-surface"');
  const start = chatSource.lastIndexOf('<HullModal', marker);
  const end = chatSource.indexOf('</HullModal>', marker);
  return chatSource.slice(start, end);
}

describe('Room member picker sizing', () => {
  it('caps the modal wrapper, not the surface, so the list gets a real height', () => {
    expect(pickerMarkup()).toContain('contentStyle={styles.memberModalContent}');
    expect(chatSource).toContain("memberModalContent: { maxHeight: '78%' }");
    const surface = chatSource.slice(
      chatSource.indexOf('    memberModal: {'),
      chatSource.indexOf('    memberModalHeading:'),
    );
    expect(surface).toContain("maxHeight: '100%'");
    expect(surface).not.toContain("maxHeight: '78%'");
  });

  it('scrolls the whole IN ROOM + ADD list inside the surface', () => {
    const markup = pickerMarkup();
    expect(markup).toContain('<ScrollView');
    expect(markup.indexOf("label: 'IN ROOM'")).toBeGreaterThan(markup.indexOf('<ScrollView'));
    expect(markup.indexOf("label: 'ADD'")).toBeLessThan(markup.indexOf('</ScrollView>'));
  });
});

/**
 * Captain report C59: a one-person workspace rendered "@You" and nothing
 * else — no way to bring a person or an agent in. The picker now always
 * ends with `RoomMemberPickerActions` (its own render test covers the
 * empty line, the manager gate, and both rows); this pins the wiring to
 * the product's existing invite flows.
 */
describe('Room member picker invite actions', () => {
  it('renders the action rows inside the scroll list, after the ADD section', () => {
    const markup = pickerMarkup();
    const actions = markup.indexOf('<RoomMemberPickerActions');
    expect(actions).toBeGreaterThan(markup.indexOf("label: 'ADD'"));
    expect(actions).toBeLessThan(markup.indexOf('</ScrollView>'));
    expect(markup).toContain('addableCount={participantPickerSections.addable.length}');
    expect(markup).toContain('canManage={roomSurface?.viewer.permissions.manage ?? false}');
    expect(markup).not.toContain('Workspace roster is empty');
  });

  it('invites a person through the workspace invite URL and the Share sheet', () => {
    const handler = chatSource.slice(
      chatSource.indexOf('const handleInvitePerson = useCallback('),
      chatSource.indexOf('const handleAddAgent = useCallback('),
    );
    expect(handler).toContain('createCommunityInviteUrl(');
    expect(handler).toContain('resolveCommunityInvitePublicOrigin(');
    expect(handler).toContain('Share.share({ message: url })');
    expect(handler).toContain('setMembershipError(`Could not create person invite:');
  });

  it('adds an agent through the members screen pairing flow and closes the picker', () => {
    const handler = chatSource.slice(
      chatSource.indexOf('const handleAddAgent = useCallback('),
      chatSource.indexOf('const returnToRoomList = useCallback('),
    );
    expect(handler).toContain('setParticipantPickerVisible(false)');
    expect(handler).toContain("pathname: '/beeline/members'");
    expect(handler).toContain("action: 'add-agent'");
  });
});
