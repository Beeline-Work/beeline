import type { WorkspaceSnapshot } from './types.js';

/**
 * Remove live-only machine state before a normalized snapshot crosses a disk
 * boundary. Conversation, control, lifecycle, membership, and consequential
 * activity facts remain; drafts, thoughts, turn markers, presence, and routine
 * tool telemetry are deliberately memory-only.
 */
export function snapshotForPersistence(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  let changed = false;
  const rooms = Object.fromEntries(
    Object.entries(snapshot.rooms).map(([channelId, room]) => {
      let roomChanged = false;
      const eventJournal = Object.fromEntries(
        Object.entries(room.eventJournal).filter(([, event]) => {
          const keep =
            event.type !== 'session-update' &&
            (event.type !== 'activity' || event.durableFact !== undefined);
          if (!keep) {
            changed = true;
            roomChanged = true;
          }
          return keep;
        }),
      );
      return [channelId, roomChanged ? { ...room, eventJournal } : room];
    }),
  );
  return changed ? { ...snapshot, rooms } : snapshot;
}

export type ReadModelBootResult =
  | { readonly status: 'ready'; readonly snapshot: WorkspaceSnapshot }
  | {
      readonly status: 'integrity-halt';
      readonly code:
        'missing-cache' | 'schema-mismatch' | 'invalid-snapshot' | 'snapshot-integrity';
      readonly diagnostic: string;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Cache corruption never becomes an empty transcript. The only successful
 * branch returns the normalized snapshot; every other branch is a loud halt.
 */
export function guardReadModelBoot(value: unknown): ReadModelBootResult {
  if (value === undefined || value === null) {
    return {
      status: 'integrity-halt',
      code: 'missing-cache',
      diagnostic: 'No normalized read-model snapshot is available. Relay rebuild is required.',
    };
  }
  const parsed = record(value);
  if (!parsed) {
    return {
      status: 'integrity-halt',
      code: 'invalid-snapshot',
      diagnostic: 'The normalized read-model cache is not an object.',
    };
  }
  if (parsed.schemaVersion !== 1) {
    return {
      status: 'integrity-halt',
      code: 'schema-mismatch',
      diagnostic: `Unsupported read-model schema ${String(parsed.schemaVersion)}. Relay rebuild is required.`,
    };
  }
  if (
    typeof parsed.workspaceId !== 'string' ||
    !Number.isSafeInteger(parsed.revision) ||
    !record(parsed.identities) ||
    !record(parsed.rooms) ||
    !Array.isArray(parsed.diagnostics)
  ) {
    return {
      status: 'integrity-halt',
      code: 'invalid-snapshot',
      diagnostic: 'The normalized read-model cache failed structural validation.',
    };
  }
  const snapshot = parsed as WorkspaceSnapshot;
  const brokenRoom = Object.values(snapshot.rooms).find(
    (room) =>
      !room ||
      room.channelId === undefined ||
      !record(room.eventJournal) ||
      !record(room.corners) ||
      !room.coverage ||
      (room.membership.status !== 'known' && room.membership.status !== 'unknown'),
  );
  if (brokenRoom) {
    return {
      status: 'integrity-halt',
      code: 'snapshot-integrity',
      diagnostic: `Room ${String(brokenRoom.channelId)} failed normalized snapshot validation.`,
    };
  }
  return { status: 'ready', snapshot };
}
