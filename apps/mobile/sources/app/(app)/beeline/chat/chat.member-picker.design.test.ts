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
