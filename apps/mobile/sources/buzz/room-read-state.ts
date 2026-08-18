import { MMKV } from 'react-native-mmkv';
import { create } from 'zustand';

/**
 * Per-Room read marks: "the newest message I had seen when I last left this
 * Room", in relay seconds.
 *
 * Deliberately its own tiny MMKV store rather than a field on the Buzz local
 * cache. That cache holds up to 30 full transcripts and may only be serialized
 * on the background transition (see `local-cache.ts`); a read mark is a single
 * number written on a navigation event, so it can flush synchronously without
 * violating that rule. Keep it that way — never grow this store into anything a
 * foreground interaction would have to serialize.
 */
const STORAGE_KEY = 'buzz-room-reads-v1';
const MAX_TRACKED_ROOMS = 200;

const storage = new MMKV({ id: 'buzz-room-reads' });

type RoomReadState = {
  /** `<viewerPubkey>/<roomId>` → relay seconds of the newest message read. */
  readAt: Record<string, number>;
  markRoomRead: (viewerPubkey: string, roomId: string, atSeconds: number) => void;
};

function readKey(viewerPubkey: string, roomId: string): string {
  return `${viewerPubkey}/${roomId}`;
}

function hydrate(): Record<string, number> {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}

/** Keep only the most recently read Rooms so the record cannot grow forever. */
function bounded(readAt: Record<string, number>): Record<string, number> {
  const entries = Object.entries(readAt);
  if (entries.length <= MAX_TRACKED_ROOMS) return readAt;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_TRACKED_ROOMS));
}

export const useRoomReadState = create<RoomReadState>((set, get) => ({
  readAt: hydrate(),
  markRoomRead: (viewerPubkey, roomId, atSeconds) => {
    const key = readKey(viewerPubkey, roomId);
    const current = get().readAt;
    // A read mark only ever moves forward. Re-entering a quiet Room must not
    // walk it back and resurrect an unread badge for messages already seen.
    if ((current[key] ?? 0) >= atSeconds) return;
    const readAt = bounded({ ...current, [key]: atSeconds });
    set({ readAt });
    storage.set(STORAGE_KEY, JSON.stringify(readAt));
  },
}));

export function roomReadAt(
  readAt: Record<string, number>,
  viewerPubkey: string | undefined,
  roomId: string,
): number | undefined {
  if (!viewerPubkey) return undefined;
  return readAt[readKey(viewerPubkey, roomId)];
}

/**
 * A Room is unread when its newest person-facing message is newer than the
 * read mark. A Room that has never been opened is *not* unread on that basis
 * alone — an untouched Workspace would otherwise light up every row at once,
 * which teaches the reader to ignore the signal. The first open records the
 * mark; everything after it is genuinely new.
 */
export function isRoomUnread(
  readAtSeconds: number | undefined,
  latestMessageAt: number | undefined,
): boolean {
  if (!latestMessageAt) return false;
  if (readAtSeconds === undefined) return false;
  return latestMessageAt > readAtSeconds;
}
