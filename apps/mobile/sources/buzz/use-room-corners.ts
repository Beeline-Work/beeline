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
import {
  applyArchivedCorners,
  applyCornerListRead,
  applyOpenCornerPage,
  cornerReadMark,
  getRoomCorners,
  hydrateRoomCorners,
  noteCornerReadStarted,
  roomCornerListView,
  useRoomCornerRecord,
  type RoomCorners,
} from '@/buzz/room-corner-store';

/** A socket that never answers must not hold the first read. */
const SUBSCRIBE_HANDSHAKE_TIMEOUT_MS = 2_000;

type CornersClient = Pick<RoomViewClient, 'corners'>;

type Reader = {
  readonly client: CornersClient;
  /** Where the first page is saved; absent without an identity to key it by. */
  readonly address?: ReturnType<typeof surfaceAddress>;
};

/** One first-page read per Room in flight, shared by every reader. */
const firstPageReads = new Map<string, { again: boolean; done: Promise<void> }>();

async function roomReader(roomId: string, client: CornersClient | undefined): Promise<Reader> {
  const identity = (await loadBuzzIdentity()) as Identity | null;
  if (!identity) {
    if (client) return { client };
    throw new Error('Beeline identity is unavailable');
  }
  const relayUrl = await getEffectiveRelayUrl();
  return {
    client: client ?? new RoomViewClient({ baseUrl: relayUrl, identity }),
    address: surfaceAddress(relayUrl, identity.publicKey, '/room/:id/corners', { roomId }),
  };
}

/**
 * Read the first page, or join the read in flight. A change the record wants
 * read while it runs, or a `force` from a reader that asked after it began,
 * reads once more.
 */
function readFirstPage(roomId: string, reader: Reader, force: boolean): Promise<void> {
  const running = firstPageReads.get(roomId);
  if (running) {
    if (force) running.again = true;
    return running.done;
  }
  const flight = { again: false, done: Promise.resolve() };
  flight.done = (async () => {
    try {
      do {
        flight.again = false;
        noteCornerReadStarted(roomId);
        const mark = cornerReadMark(roomId);
        const view = await reader.client.corners(roomId);
        applyCornerListRead(roomId, view, mark);
        const held = roomCornerListView(getRoomCorners(roomId));
        if (held && reader.address)
          void mobileSurfaceCache.write(reader.address, held, isCornerListView);
      } while (flight.again || getRoomCorners(roomId).wantsRead);
    } finally {
      firstPageReads.delete(roomId);
    }
  })();
  firstPageReads.set(roomId, flight);
  return flight.done;
}

/** Read open pages after the first until they hold as many rows as before. */
async function rereadOpenPages(roomId: string, reader: Reader): Promise<void> {
  const held = getRoomCorners(roomId);
  const target = held.openMore.length;
  let next = held.firstPageNext;
  const rows: CornerListItem[] = [];
  while (next && rows.length < target) {
    const page = await reader.client.corners(roomId, { openBefore: next });
    rows.push(...page.corners);
    next = page.nextOpen;
  }
  applyOpenCornerPage(roomId, rows, next, true);
}

/** Read archived pages until they hold as many rows as before. */
async function rereadArchivedPages(roomId: string, reader: Reader): Promise<void> {
  const target = Math.max(1, getRoomCorners(roomId).archived?.corners.length ?? 0);
  let next: string | undefined;
  const rows: CornerListItem[] = [];
  do {
    const page = await reader.client.corners(roomId, {
      archived: true,
      ...(next ? { before: next } : {}),
    });
    rows.push(...page.corners);
    next = page.nextArchived;
  } while (next && rows.length < target);
  applyArchivedCorners(roomId, rows, next, false);
}

export type RoomCornersHandle = {
  readonly record: RoomCorners | undefined;
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
  const readerRef = useRef<Promise<Reader> | null>(null);
  const readyRef = useRef(false);
  const refreshingOpen = useRef(false);
  const refreshingArchived = useRef(false);

  const reader = useCallback(() => {
    if (!roomId) return Promise.reject(new Error('No Room'));
    readerRef.current ??= roomReader(roomId, client ?? undefined);
    return readerRef.current;
  }, [client, roomId]);

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
        const { address } = await reader();
        if ((!held.header || !held.rows) && address) {
          const saved = await mobileSurfaceCache.read(address, isCornerListView);
          if (cancelled) return;
          if (saved) hydrateRoomCorners(roomId, saved);
        }
        await live.whenSubscribed(filters, SUBSCRIBE_HANDSHAKE_TIMEOUT_MS);
        if (cancelled) return;
        readyRef.current = true;
        const now = getRoomCorners(roomId);
        if (!now.current || !now.header || now.wantsRead) await read(false);
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
        .then((value) => rereadOpenPages(roomId, value))
        .catch((reason) => setError(phoneOperationFailureReason(reason)))
        .finally(() => { refreshingOpen.current = false; });
    }
    if (record.archivedStale && record.archived && !refreshingArchived.current) {
      refreshingArchived.current = true;
      void reader()
        .then((value) => rereadArchivedPages(roomId, value))
        .catch((reason) => setError(phoneOperationFailureReason(reason)))
        .finally(() => { refreshingArchived.current = false; });
    }
  }, [read, reader, record, roomId]);

  const loadMoreOpen = useCallback(async () => {
    if (!roomId) return;
    const cursor = getRoomCorners(roomId).nextOpen;
    if (!cursor) return;
    const page = await (await reader()).client.corners(roomId, { openBefore: cursor });
    // A frame or another page may have moved the cursor while this one read.
    if (getRoomCorners(roomId).nextOpen !== cursor) return;
    applyOpenCornerPage(roomId, page.corners, page.nextOpen);
  }, [reader, roomId]);

  const loadArchived = useCallback(async (more: boolean) => {
    if (!roomId) return;
    const before = more ? getRoomCorners(roomId).archived?.next : undefined;
    if (more && !before) return;
    const page = await (await reader()).client.corners(roomId, {
      archived: true,
      ...(before ? { before } : {}),
    });
    applyArchivedCorners(roomId, page.corners, page.nextArchived, more);
  }, [reader, roomId]);

  const view = useMemo(() => (record ? roomCornerListView(record) : undefined), [record]);
  return {
    record,
    view,
    error,
    refresh,
    loadMoreOpen,
    loadArchived,
  };
}
