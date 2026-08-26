import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
  },
}));

// The chat screen's transcript memo reads this module; importing it keeps the
// cache module-scope state honest without pulling React Native in.
import {
  resetTranscriptProjectionCache,
  transcriptMessages,
} from '@/sync/transport/buzz-event-projection';
import type { HumanMessage, WorkspaceSnapshot } from '@beeline/buzz-client';

function humanEvent(index: number, body = 'hello from the ledger'): HumanMessage {
  return {
    type: 'human-message',
    eventId: `identity-${index}`,
    channelId: 'room-identity',
    workspaceId: 'workspace',
    scope: 'channel',
    authorPubkey: 'viewer',
    createdAt: index + 1,
    sourceKind: 9,
    signature: 'verified',
    body,
    attachments: [],
    mentionPubkeys: [],
  } as unknown as HumanMessage;
}

let snapshot: WorkspaceSnapshot;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const client = require('@beeline/buzz-client');
  snapshot = client.reduceWorkspaceEvents(
    client.createWorkspaceSnapshot({ workspaceId: 'workspace' }),
    [humanEvent(0), humanEvent(1), humanEvent(2)],
  );
});

describe('transcript projection identity stability', () => {
  it('hands back the SAME DTO objects for untouched events across re-projections', () => {
    const first = transcriptMessages(snapshot, 'room-identity', 'viewer');
    const second = transcriptMessages(snapshot, 'room-identity', 'viewer');
    expect(second).toHaveLength(first.length);
    for (let index = 0; index < first.length; index += 1) {
      // Reference equality is the contract: a new object identity per commit
      // forces FlatList to rebuild every visible ledger row on every pump
      // chunk, which is exactly the corner-screen freeze family.
      expect(second[index]).toBe(first[index]);
    }
  });

  it('keeps untouched rows identity-stable when a live batch appends one event', () => {
    const before = transcriptMessages(snapshot, 'room-identity', 'viewer');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const client = require('@beeline/buzz-client');
    const after = client.reduceWorkspaceEvents(snapshot, [humanEvent(3)]);
    const projected = transcriptMessages(after, 'room-identity', 'viewer');

    expect(projected).toHaveLength(before.length + 1);
    for (let index = 0; index < before.length; index += 1) {
      expect(projected[index]).toBe(before[index]);
    }
    expect(projected[3]!.id).toBe('identity-3');
  });

  it('reprojects only the event whose content actually changed', () => {
    const before = transcriptMessages(snapshot, 'room-identity', 'viewer');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const client = require('@beeline/buzz-client');
    // A repaired/re-derived journal entry is a NEW object with the same id:
    // the cache must miss for it and hit for every sibling.
    const changedJournal = {
      ...snapshot.rooms['room-identity']!.eventJournal,
      'identity-1': humanEvent(1, 'edited body'),
    };
    const repaired: WorkspaceSnapshot = {
      ...snapshot,
      rooms: {
        ...snapshot.rooms,
        'room-identity': { ...snapshot.rooms['room-identity']!, eventJournal: changedJournal },
      },
    };
    const projected = transcriptMessages(repaired, 'room-identity', 'viewer');

    expect(projected[0]).toBe(before[0]);
    expect(projected[2]).toBe(before[2]);
    expect(projected[1]).not.toBe(before[1]);
    expect(projected[1]!.text).toBe('edited body');
  });

  it('keys the cache per viewer and per isNew, so neither leaks across calls', () => {
    const owner = transcriptMessages(snapshot, 'room-identity', 'viewer');
    const other = transcriptMessages(snapshot, 'room-identity', 'someone-else');
    expect(owner[0]!.isUser).toBe(true);
    expect(other[0]!.isUser).toBe(false);
    expect(owner[0]).not.toBe(other[0]);

    const warm = transcriptMessages(snapshot, 'room-identity', 'viewer');
    const fresh = transcriptMessages(snapshot, 'room-identity', 'viewer', {
      newIds: new Set(['identity-0']),
    });
    expect(warm[0]!.isNew).toBeUndefined();
    expect(fresh[0]!.isNew).toBe(true);
    // The isNew variant must not evict or alias the warm projection.
    expect(transcriptMessages(snapshot, 'room-identity', 'viewer')[0]).toBe(warm[0]);
  });

  it('drops every cached projection on reset (test seam)', () => {
    resetTranscriptProjectionCache();
    const first = transcriptMessages(snapshot, 'room-identity', 'viewer');
    resetTranscriptProjectionCache();
    const second = transcriptMessages(snapshot, 'room-identity', 'viewer');
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toEqual(first[0]);
  });
});
