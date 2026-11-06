import type { ChannelMember, ChannelRole } from '@beeline/buzz-client';

export type RoomLifecycleAction = 'delete' | 'leave' | null;

export function normalizedRoomRole(member: ChannelMember | undefined): ChannelRole | null {
  if (!member) return null;
  return member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
}
