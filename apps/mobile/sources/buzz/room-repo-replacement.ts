import { useCallback } from 'react';
import type { ChatListItem, RoomRepository } from '@beeline/buzz-client';
import { Modal } from '@/modal';
import { CORNER_LABEL, ROOM_LABEL } from './vocabulary';

/**
 * The Room screen's repository-change guard. It reads the open-corner count
 * from the live Room list, so a corner that opens while the screen is up is
 * counted. Changing the repo under a Room with open corners strands those
 * corners on the old repo, so re-binding is confirmed like the other
 * destructive Room actions (delete/leave), and skipped when there is nothing
 * to strand.
 */
export function useRoomRepoReplacementGuard(
  chats: readonly ChatListItem[],
  roomId: string,
  roomRepository: RoomRepository | null,
): { readonly openCornerCount: number; readonly confirmReplacement: () => Promise<boolean> } {
  const openCornerCount = chats.find((item) => item.room.id === roomId)?.cornerCount ?? 0;
  const confirmReplacement = useCallback(async () => {
    const hasOpenCorners = openCornerCount > 0;
    if (!roomRepository || !hasOpenCorners) return true;
    return Modal.confirm(
      `Change ${ROOM_LABEL} repo?`,
      `This ${ROOM_LABEL} has ${CORNER_LABEL}s still open on ${roomRepository.binding.name}. Changing the repo will not move them — they stay bound to the old repo.`,
      { cancelText: 'Cancel', confirmText: 'Change anyway', destructive: true },
    );
  }, [openCornerCount, roomRepository]);
  return { openCornerCount, confirmReplacement };
}
