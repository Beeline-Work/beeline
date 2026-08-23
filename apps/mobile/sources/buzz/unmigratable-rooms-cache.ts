import { MMKV } from 'react-native-mmkv';
import type { UnmigratableRoom } from '@beeline/buzz-client';

/**
 * Durable verdicts for rooms a successor key can provably never self-join:
 * the relay stores the kind:9000 member-add but its kind:39002 projection
 * never updates (upstream honors member-adds only when authored by a room
 * admin — an orphaned room with no living admin admits nobody). Without this
 * record every app launch would re-assert the full 15s projection wait for a
 * permanently-known answer before Workspace discovery could finish.
 *
 * Deliberately its own tiny MMKV store, written synchronously only at
 * bootstrap boundaries (see `workspace-bootstrap.ts`) — never from a
 * foreground interaction, mirroring `room-read-state.ts`'s discipline.
 */
const STORAGE_KEY = 'buzz-unmigratable-rooms-v1';
const MAX_TRACKED_ROOMS = 200;

type KeyValueStore = { getString(key: string): string | undefined; set(key: string, value: string): void };

// Lazily instantiated: node-side unit tests (and any environment without the
// native module) fall back to process memory instead of failing at import.
const memoryFallback = new Map<string, string>();
let storage: KeyValueStore | null = null;

function store(): KeyValueStore {
  if (!storage) {
    try {
      storage = new MMKV({ id: 'buzz-succession' });
    } catch {
      storage = {
        getString: (key) => memoryFallback.get(key),
        set: (key, value) => {
          memoryFallback.set(key, value);
        },
      };
    }
  }
  return storage;
}

function entryKey(viewerPubkey: string, room: UnmigratableRoom): string {
  return `${viewerPubkey}/${room.channelId}:${room.pubkey}`;
}

type StoredRecord = Record<string, number>;

function hydrate(): StoredRecord {
  try {
    const raw = store().getString(STORAGE_KEY);
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

/** Keep only the newest verdicts so the record cannot grow forever. */
function bounded(record: StoredRecord): StoredRecord {
  const entries = Object.entries(record);
  if (entries.length <= MAX_TRACKED_ROOMS) return record;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_TRACKED_ROOMS));
}

/** Verdicts recorded for this viewer on earlier launches. */
export function loadUnmigratableRooms(viewerPubkey: string): UnmigratableRoom[] {
  const prefix = `${viewerPubkey}/`;
  return Object.entries(hydrate())
    .filter(([key]) => key.startsWith(prefix))
    .map(([key]) => {
      const rest = key.slice(prefix.length);
      const separator = rest.indexOf(':');
      return { channelId: rest.slice(0, separator), pubkey: rest.slice(separator + 1) };
    })
    .filter((room) => Boolean(room.channelId && room.pubkey));
}

/** Replace this viewer's durable verdicts with the session's current set. */
export function saveUnmigratableRooms(viewerPubkey: string, rooms: readonly UnmigratableRoom[]): void {
  const prefix = `${viewerPubkey}/`;
  const record: StoredRecord = Object.fromEntries(
    Object.entries(hydrate()).filter(([key]) => !key.startsWith(prefix)),
  );
  const now = Date.now();
  for (const room of rooms) {
    record[entryKey(viewerPubkey, room)] = now;
  }
  try {
    store().set(STORAGE_KEY, JSON.stringify(bounded(record)));
  } catch {
    // Persistence is an optimization; a failed write only costs a later
    // launch one projection wait, never correctness.
  }
}
