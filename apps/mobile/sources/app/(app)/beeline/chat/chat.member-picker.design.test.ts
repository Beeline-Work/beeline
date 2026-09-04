import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source contract for the Room's "Add people or agents" picker. Captain
 * report C74 (v0.0.40): the old inline picker built its candidates from this
 * Room's OWN member list, so its add section was always empty and the only
 * visible path led to the pairing command on the Members page. The Room now
 * mounts the one shared `MemberPickerSheet`, fed by a Workspace-roster read
 * minus the Room's current members, and adds every checked row through the
 * existing Room membership operations.
 */
const chatSource = readFileSync(path.join(__dirname, '[channelId].tsx'), 'utf8');

function between(start: string, end: string): string {
  const from = chatSource.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = chatSource.indexOf(end, from);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return chatSource.slice(from, to);
}

describe('Room member picker', () => {
  it('mounts the one shared picker sheet instead of an inline modal', () => {
    expect(chatSource).toContain("from '@/components/buzz/MemberPickerSheet'");
    expect(chatSource).toContain('<MemberPickerSheet');
    expect(chatSource).not.toContain('accessibilityLabel="Close Room member picker"');
    expect(chatSource).not.toContain('room-member-picker-surface');
    expect(chatSource).not.toContain("label: 'IN ROOM'");
  });

  it('reads the Workspace roster when the picker opens and offers only members not yet in the Room', () => {
    const effect = between(
      '  useEffect(() => {\n    if (!participantPickerVisible',
      '  }, [activeCommunityId, participantPickerVisible, roomClient]);',
    );
    expect(effect).toContain('.workspace(activeCommunityId)');
    expect(effect).toContain('setWorkspaceRoster(null)');
    const memo = between(
      'const participantPickerCandidates = useMemo',
      '}, [roomMemberPubkeys, workspaceRoster]);',
    );
    expect(memo).toContain('[...workspaceRoster.members, ...workspaceRoster.agents]');
    expect(memo).toContain('!roomMemberPubkeys.has(member.identity.pubkey)');
    const sheet = between('<MemberPickerSheet', '/>');
    expect(sheet).toContain('candidates={participantPickerCandidates}');
    expect(sheet).toContain('kind={participantPickerKind}');
    expect(sheet).toContain('canManage={roomSurface?.viewer.permissions.manage ?? false}');
  });

  it('carries no add control in the header: the members line is the one way in (C83)', () => {
    // Captain report C83 (v0.0.43): the header `+` opened the same picker the
    // `N members ›` line already reaches through the roster sheet, and opened
    // with no section in scope it could only report the Workspace as empty.
    expect(chatSource).not.toContain('testID="room-member-picker"');
    expect(chatSource).not.toContain('addMembersButton');
    expect(chatSource).not.toContain('addMembersGlyph');
    expect(chatSource).not.toContain('setParticipantPickerKind(null)');
    // The overflow stays, and it is the only trailing control.
    expect(chatSource).toContain('testID="room-actions-menu"');
  });

  it('opens the roster from the members line, and the picker from the roster’s own heads', () => {
    const at = chatSource.indexOf('testID="room-participant-roster-trigger"');
    expect(at, 'missing the roster trigger').toBeGreaterThanOrEqual(0);
    // The trigger is the whole title column, and the members line lives in it.
    const opener = chatSource.slice(at - 900, at);
    expect(opener).toContain('accessibilityRole="button"');
    expect(opener).toContain('setRosterVisible(true)');
    expect(chatSource.slice(at, at + 3200)).toContain('testID="room-header-meta"');

    const roster = between('<RoomRosterSheet', 'visible={rosterVisible}');
    expect(roster).toContain("setParticipantPickerKind('agent')");
    expect(roster).toContain("setParticipantPickerKind('person')");
    expect(roster.match(/setParticipantPickerVisible\(true\)/g)).toHaveLength(2);
  });

  it('tells the picker how many Workspace peers exist so its empty line is true', () => {
    const memo = between(
      'const participantPickerWorkspacePeers = useMemo',
      '}, [participantPickerKind, userPubkey, workspaceRoster]);',
    );
    expect(memo).toContain('member.identity.pubkey === userPubkey');
    expect(memo).toContain('kind === participantPickerKind');
    const sheet = between('<MemberPickerSheet', '/>');
    expect(sheet).toContain('workspacePeerCount={participantPickerWorkspacePeers}');
  });

  it('adds every checked person or agent through the existing Room membership operations', () => {
    const handler = between(
      'const handleAddRoomMembers = useCallback(',
      'const handleRemoveRoomMember = useCallback(',
    );
    expect(handler).toContain(
      'transport.inviteAgentToChannel(decodedId, candidate.pubkey, activeCommunityId)',
    );
    expect(handler).toContain('transport.inviteWorkspaceMemberToChannel(');
    expect(handler).toContain('setParticipantPickerVisible(false)');
    expect(handler).toContain('setMembershipError(`Could not add @${current.name}:');
  });

  it('invites a person through the workspace invite URL and the Share sheet', () => {
    const handler = between(
      'const handleInvitePerson = useCallback(',
      'const handleConnectAgent = useCallback(',
    );
    expect(handler).toContain('createCommunityInviteUrl(');
    expect(handler).toContain('resolveCommunityInvitePublicOrigin(');
    expect(handler).toContain('Share.share({ message: url })');
    expect(handler).toContain('setMembershipError(`Could not create person invite:');
  });

  it('connects a NEW agent through the members screen pairing flow and closes the picker', () => {
    const handler = between(
      'const handleConnectAgent = useCallback(',
      'const returnToRoomList = useCallback(',
    );
    expect(handler).toContain('setParticipantPickerVisible(false)');
    expect(handler).toContain("pathname: '/beeline/members'");
    expect(handler).toContain("action: 'add-agent'");
  });
});
