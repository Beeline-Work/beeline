import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isCornerListView,
  type CornerListItem,
  type CornerListView,
  type Identity,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { subscribeClientReset } from '@/sync/client-reset';
import { cornerHeaderItem, type CornerDisplayItem } from '@/buzz/corner-display-state';
import {
  applyArchivedCorners,
  applyCornerListRead,
  applyOpenCornerPage,
  cornerReadMark,
  cornerStoreGeneration,
  findRoomCornerRow,
  getRoomCorners,
  hydrateRoomCorners,
  noteCornerReadStarted,
  roomCornerListView,
  roomOpenCornerRows,
  shareCornerRead,
  useRoomCornerRecord,
  type RoomCorners,
} from '@/buzz/room-corner-store';

/** A socket that never answers must not hold the first read. */
const SUBSCRIBE_HANDSHAKE_TIMEOUT_MS = 2_000;

type CornersClient = Pick<RoomViewClient, 'corners'>;

type Reader = {
  readonly client: CornersClient;
  readonly key: string;
  readonly generation: number;
  /** Where the first page is saved; absent without an identity to key it by. */
  readonly address?: ReturnType<typeof surfaceAddress>;
};

async function roomReader(roomId: string, client: CornersClient | undefined): Promise<Reader> {
  const generation = cornerStoreGeneration();
  const identity = (await loadBuzzIdentity()) as Identity | null;
  if (!identity) {
    if (client) return { client, key: roomId, generation };
    throw new Error('Beeline identity is unavailable');
  }
  const relayUrl = await getEffectiveRelayUrl();
  return {
    client: client ?? new RoomViewClient({ baseUrl: relayUrl, identity }),
    key: JSON.stringify([relayUrl, identity.publicKey, roomId]),
    generation,
    address: surfaceAddress(relayUrl, identity.publicKey, '/room/:id/corners', { roomId }),
  };
}

function readFirstPage(roomId: string, reader: Reader, force: boolean): Promise<void> {
  if (reader.generation !== cornerStoreGeneration()) return Promise.resolve();
  return shareCornerRead(reader.key, force, async () => {
    noteCornerReadStarted(roomId);
    const mark = cornerReadMark(roomId);
    const view = await reader.client.corners(roomId);
    applyCornerListRead(roomId, view, mark);
    if (reader.generation !== cornerStoreGeneration()) return false;
    const held = roomCornerListView(getRoomCorners(roomId));
    if (held && reader.address)
      void mobileSurfaceCache.write(reader.address, held, isCornerListView);
    return getRoomCorners(roomId).wantsRead;
  });
}

/** Refill held pages after a frame changed their membership or state. */
async function rereadPages(roomId: string, reader: Reader, archived: boolean): Promise<void> {
  if (reader.generation !== cornerStoreGeneration()) return;
  do {
    const mark = cornerReadMark(roomId);
    if (reader.generation !== mark.generation) return;
    const held = getRoomCorners(roomId);
    const target = archived ? Math.max(1, held.archived?.corners.length ?? 0) : held.openMore.length;
    let next = archived ? undefined : held.firstPageNext;
    const rows: CornerListItem[] = [];
    do {
      if (!archived && !next) break;
      const page = await reader.client.corners(roomId,
        archived ? { archived: true, ...(next ? { before: next } : {}) } : { openBefore: next! });
      rows.push(...page.corners);
      next = archived ? page.nextArchived : page.nextOpen;
    } while (next && rows.length < target);
    if (archived) applyArchivedCorners(roomId, rows, next, false, mark);
    else applyOpenCornerPage(roomId, rows, next, mark, true);
  } while (!archived && getRoomCorners(roomId).openMoreStale && getRoomCorners(roomId).openMore.length > 0);
}

type RoomCornersHandle = {
  readonly record: RoomCorners | undefined;
  /** The first page and the held pages after it, as one list. */
  readonly openRows: readonly CornerListItem[];
  /** The first page with its Room and viewer, once both are held. */
  readonly view: CornerListView | undefined;
  readonly error: string | null;
  refresh(): Promise<void>;
  loadMoreOpen(): Promise<void>;
  loadArchived(more: boolean): Promise<void>;
};

/**
 * Hold a Room's lane and keep its corner record current. Rows the lane already
 * proved paint with no read; a read happens only when the record cannot prove
 * it saw every change. `client` reads for a caller that already holds one.
 */
export function useRoomCorners(
  roomId: string | undefined,
  client?: CornersClient | null,
): RoomCornersHandle {
  const record = useRoomCornerRecord(roomId);
  const [error, setError] = useState<string | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const readerRef = useRef<Promise<Reader> | null>(null);
  const readyRef = useRef(false);
  const refreshingOpen = useRef(false);
  const refreshingArchived = useRef(false);

  useEffect(() => subscribeClientReset(() => setAccountEpoch((value) => value + 1)), []);

  const reader = useCallback(() => {
    if (!roomId) return Promise.reject(new Error('No Room'));
    readerRef.current ??= roomReader(roomId, client ?? undefined);
    return readerRef.current;
  }, [client, roomId, accountEpoch]);

  const read = useCallback(async (force: boolean) => {
    if (!roomId) return;
    try {
      await readFirstPage(roomId, await reader(), force);
      setError(null);
    } catch (reason) {
      setError(phoneOperationFailureReason(reason));
    }
  }, [reader, roomId]);
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    readyRef.current = false;
    readerRef.current = null;
    setError(null);
    const filters = [{ '#h': [roomId] }] as const;
    const live = sharedLiveConnection();
    const holding = live.register(filters, () => undefined);
    void (async () => {
      try {
        const held = getRoomCorners(roomId);
        const { address, generation } = await reader();
        if (generation !== cornerStoreGeneration()) return;
        if ((!held.header || !held.rows) && address) {
          const saved = await mobileSurfaceCache.read(address, isCornerListView);
          if (cancelled || generation !== cornerStoreGeneration()) return;
          if (saved) hydrateRoomCorners(roomId, saved);
        }
        await live.whenSubscribed(filters, SUBSCRIBE_HANDSHAKE_TIMEOUT_MS);
        if (cancelled) return;
        readyRef.current = true;
        const now = getRoomCorners(roomId);
        if (!now.current || !now.headerRead || now.wantsRead) await read(false);
      } catch (reason) {
        if (!cancelled) setError(phoneOperationFailureReason(reason));
      }
    })();
    return () => {
      cancelled = true;
      readyRef.current = false;
      void holding.then((stop) => stop());
    };
  }, [read, reader, roomId]);

  useEffect(() => {
    if (!roomId || !record || !readyRef.current) return;
    if (record.wantsRead) void read(false);
    if (record.openMoreStale && record.openMore.length > 0 && !refreshingOpen.current) {
      refreshingOpen.current = true;
      void reader()
        .then((value) => rereadPages(roomId, value, false))
        .catch((reason) => setError(phoneOperationFailureReason(reason)))
        .finally(() => { refreshingOpen.current = false; });
    }
    if (record.archivedStale && record.archived && !refreshingArchived.current) {
      refreshingArchived.current = true;
      void reader()
        .then((value) => rereadPages(roomId, value, true))
        .catch((reason) => setError(phoneOperationFailureReason(reason)))
        .finally(() => { refreshingArchived.current = false; });
    }
  }, [read, reader, record, roomId]);

  const loadMoreOpen = useCallback(async () => {
    if (!roomId) return;
    const cursor = getRoomCorners(roomId).nextOpen;
    if (!cursor) return;
    const mark = cornerReadMark(roomId);
    const source = await reader();
    if (source.generation !== mark.generation) return;
    const page = await source.client.corners(roomId, { openBefore: cursor });
    // A frame or another page may have moved the cursor while this one read.
    if (getRoomCorners(roomId).nextOpen !== cursor) return;
    applyOpenCornerPage(roomId, page.corners, page.nextOpen, mark);
  }, [reader, roomId]);

  const loadArchived = useCallback(async (more: boolean) => {
    if (!roomId) return;
    const before = more ? getRoomCorners(roomId).archived?.next : undefined;
    if (more && !before) return;
    const mark = cornerReadMark(roomId);
    const source = await reader();
    if (source.generation !== mark.generation) return;
    const page = await source.client.corners(roomId, {
      archived: true,
      ...(before ? { before } : {}),
    });
    applyArchivedCorners(roomId, page.corners, page.nextArchived, more, mark);
  }, [reader, roomId]);

  const view = useMemo(() => (record ? roomCornerListView(record) : undefined), [record]);
  const openRows = useMemo(() => (record ? roomOpenCornerRows(record) : []), [record]);
  return {
    record,
    openRows,
    view,
    error,
    refresh,
    loadMoreOpen,
    loadArchived,
  };
}

/**
 * A corner header's state: this corner's row in its parent Room's record, the
 * row the Corners screen paints. Holding the parent lane keeps it current.
 */
export function useCornerHeaderItem(
  parentId: string | undefined,
  cornerId: string,
  archived: boolean,
  client?: CornersClient | null,
): CornerDisplayItem | undefined {
  const { record } = useRoomCorners(parentId, client);
  if (!parentId) return undefined;
  return cornerHeaderItem(record ? findRoomCornerRow(record, cornerId) : undefined, archived);
}
