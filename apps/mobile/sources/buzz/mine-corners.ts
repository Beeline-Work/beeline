import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import type { CornerListItem } from '@beeline/buzz-client';

/**
 * The "Mine" corner filter: on this device, the corners page and the desktop
 * rail show only corners the viewer commissioned or that await them. It is on
 * until someone turns it off, and both surfaces read one stored value, so
 * flipping it in one place flips it in the other.
 */
const MINE_CORNERS_KEY = 'beeline.corners.mine.v1';

let current: boolean | null = null;
const listeners = new Set<(mine: boolean) => void>();

/** A Corners page row or a chat-list open corner: both carry who commissioned
 * it and whether it awaits the viewer. */
type MineCandidate = {
  readonly initiator?: { readonly pubkey: string };
  readonly awaitsViewer?: CornerListItem['awaitsViewer'];
};

function isMineCorner(item: MineCandidate, viewerPubkey: string | null | undefined): boolean {
  return item.awaitsViewer === true || (!!viewerPubkey && item.initiator?.pubkey === viewerPubkey);
}

export function mineCorners<T extends MineCandidate>(
  corners: readonly T[],
  viewerPubkey: string | null | undefined,
  mine: boolean,
): readonly T[] {
  return mine ? corners.filter((item) => isMineCorner(item, viewerPubkey)) : corners;
}

async function loadMineCorners(): Promise<boolean> {
  return (await AsyncStorage.getItem(MINE_CORNERS_KEY)) !== 'all';
}

async function saveMineCorners(mine: boolean): Promise<void> {
  current = mine;
  listeners.forEach((receive) => receive(mine));
  await AsyncStorage.setItem(MINE_CORNERS_KEY, mine ? 'mine' : 'all');
}

export function useMineCorners(): readonly [boolean, (mine: boolean) => void] {
  const [mine, setMine] = useState(current ?? true);
  useEffect(() => {
    listeners.add(setMine);
    if (current === null) {
      void loadMineCorners()
        .then((saved) => {
          if (current !== null) return;
          current = saved;
          listeners.forEach((receive) => receive(saved));
        })
        .catch(() => undefined);
    } else {
      setMine(current);
    }
    return () => {
      listeners.delete(setMine);
    };
  }, []);
  const choose = useCallback((next: boolean) => {
    void saveMineCorners(next).catch(() => undefined);
  }, []);
  return [mine, choose] as const;
}
