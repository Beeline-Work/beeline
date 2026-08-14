import type { ChannelMember, ChannelRole } from '@beeline/buzz-client';

export type RoomLifecycleAction = 'delete' | 'leave' | null;

export function normalizedRoomRole(member: ChannelMember | undefined): ChannelRole | null {
  if (!member) return null;
  return member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
}

export function roomLifecycleAction(role: ChannelRole | null): RoomLifecycleAction {
  if (role === 'owner' || role === 'admin') return 'delete';
  return role === 'member' ? 'leave' : null;
}

export function canRenameRoom(role: ChannelRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

export function canRemoveRoomParticipant(
  viewerRole: ChannelRole | null,
  targetRole: ChannelRole | null,
  isSelf: boolean,
): boolean {
  if (isSelf || targetRole === 'owner') return false;
  if (viewerRole === 'owner') return targetRole === 'admin' || targetRole === 'member';
  return viewerRole === 'admin' && targetRole === 'member';
}
