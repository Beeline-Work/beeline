import { useCallback } from 'react';
import type { RoomRepository } from '@beeline/buzz-client';
import { useRoomCornerSummary } from './room-corner-store';
import { Modal } from '@/modal';
import type { RepoCandidate } from './room-repo-picker';
import { CORNER_LABEL, ROOM_LABEL } from './vocabulary';

/**
 * The Room screen's repository-change actions. They read the open-corner
 * count from the Room's corner summary, so a corner that opens while the
 * screen is up is counted. Changing the repo under a Room with open corners strands
 * those corners on the old repo, so re-binding is confirmed like the other
 * destructive Room actions (delete/leave), and skipped when there is nothing
 * to strand. Link + Save and Create + Save both replace the repo, so both ask
 * first; a declined confirm never reaches the write.
 */
export function useRoomRepoReplacementGuard(
  roomId: string,
  roomRepository: RoomRepository | null,
  write: {
    readonly link: (candidate: RepoCandidate) => Promise<void>;
    readonly create: (installationId: number, name: string) => Promise<void>;
  },
): {
  readonly openCornerCount: number;
  readonly selectCandidate: (candidate: RepoCandidate) => void;
  readonly createRepository: (installationId: number, name: string) => Promise<void>;
} {
  const openCornerCount = useRoomCornerSummary(roomId)?.cornerCount ?? 0;
  const confirmReplacement = useCallback(async () => {
    const hasOpenCorners = openCornerCount > 0;
    if (!roomRepository || !hasOpenCorners) return true;
    return Modal.confirm(
      `Change ${ROOM_LABEL} repo?`,
      `This ${ROOM_LABEL} has ${CORNER_LABEL}s still open on ${roomRepository.binding.name}. Changing the repo will not move them — they stay bound to the old repo.`,
      { cancelText: 'Cancel', confirmText: 'Change anyway', destructive: true },
    );
  }, [openCornerCount, roomRepository]);
  const { link, create } = write;
  const selectCandidate = useCallback(
    (candidate: RepoCandidate) => {
      void confirmReplacement().then((confirmed) => {
        if (confirmed) void link(candidate);
      });
    },
    [confirmReplacement, link],
  );
  const createRepository = useCallback(
    async (installationId: number, name: string) => {
      if (!(await confirmReplacement())) return;
      await create(installationId, name);
    },
    [confirmReplacement, create],
  );
  return { openCornerCount, selectCandidate, createRepository };
}
