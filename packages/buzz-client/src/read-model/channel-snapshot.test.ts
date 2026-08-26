import { readFileSync } from 'node:fs';
import { signEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import { createIdentity } from '../identity.js';
import {
  CHANNEL_SNAPSHOT_MAX_BYTES,
  CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS,
  buildStoredChannelSnapshotV1,
  channelSnapshotDigest,
  guardChannelSnapshotViewV1,
  snapshotViewerOverlay,
} from './channel-snapshot.js';
import { parseRelayEvents } from './parser.js';
import { createWorkspaceSnapshot, reduceWorkspaceEvents } from './reducer.js';
import { selectReviewSummary } from './selectors.js';
import type { EventId, HumanMessage, Pubkey, WorkspaceSnapshot } from './types.js';

const CHANNEL = '9b929b0d-5189-4dbf-b6ba-a9f4ddf81bc6';
const MEMBER = 'a'.repeat(64) as Pubkey;

function fixture(): unknown {
  return JSON.parse(
    readFileSync(new URL('./fixtures/channel-snapshot-v1.json', import.meta.url), 'utf8'),
  ) as unknown;
}

function correctlyHashedMutation(
  mutate: (value: Record<string, unknown>) => void,
): Record<string, unknown> {
  const value = fixture() as Record<string, unknown>;
  mutate(value);
  const stored = Object.fromEntries(
    Object.entries(value).filter(([key]) => !['lagMs', 'viewer', 'integrity'].includes(key)),
  );
  value.integrity = {
    ...(value.integrity as Record<string, unknown>),
    digest: channelSnapshotDigest(stored as never),
  };
  return value;
}

function manyMessageSnapshot(count: number, bodyBytes = 0): WorkspaceSnapshot {
  const messages = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const eventId = index.toString(16).padStart(64, '0') as EventId;
      const event: HumanMessage = {
        eventId,
        authorPubkey: MEMBER,
        createdAt: 100 + index,
        sourceKind: 9,
        signature: 'verified',
        scope: 'channel',
        channelId: CHANNEL as HumanMessage['channelId'],
        workspaceId: 'verified-workspace',
        type: 'human-message',
        body: bodyBytes > 0 ? 'x'.repeat(bodyBytes) : `message ${index}`,
        attachments: [],
        mentionPubkeys: [],
      };
      return [eventId, event];
    }),
  );
  return {
    schemaVersion: 1,
    workspaceId: 'verified-workspace',
    revision: count,
    identities: {
      [MEMBER]: { kind: 'human', pubkey: MEMBER, displayName: 'Captain', revision: 'profile' },
    },
    rooms: {
      [CHANNEL]: {
        channelId: CHANNEL as HumanMessage['channelId'],
        metadata: { archived: false, deleted: false },
        eventJournal: messages,
        membershipEvents: [],
        lifecycleEvents: [],
        membership: {
          status: 'known',
          members: { [MEMBER]: { pubkey: MEMBER, role: 'owner' } },
          sourceEventId: 'f'.repeat(64) as EventId,
          observedAt: 1,
        },
        corners: {},
        coverage: { initialBackfillComplete: true, epoch: 1, oldest: 100, newest: 139 },
      },
    },
    diagnostics: [],
  };
}

function manyReplySnapshot(count: number): WorkspaceSnapshot {
  const snapshot = manyMessageSnapshot(count * 2);
  const journal = snapshot.rooms[CHANNEL]!.eventJournal as unknown as Record<string, HumanMessage>;
  for (let index = 0; index < count; index += 1) {
    const parentId = index.toString(16).padStart(64, '0') as EventId;
    const replyId = (count + index).toString(16).padStart(64, '0') as EventId;
    const reply = journal[replyId] as HumanMessage;
    journal[replyId] = {
      ...reply,
      body: `reply ${index}`,
      reply: {
        channelId: CHANNEL,
        eventId: parentId,
        rootId: parentId,
      } as NonNullable<HumanMessage['reply']>,
    };
  }
  return snapshot;
}

describe('channel snapshot v1 contract', () => {
  it('accepts the one shared golden JSON fixture and verifies its digest', () => {
    const guarded = guardChannelSnapshotViewV1(fixture());
    expect(guarded.status).toBe('ready');
    if (guarded.status === 'ready') {
      expect(guarded.view.snapshot.rooms[CHANNEL]?.metadata.name).toBe('Launch Room');
    }
  });

  it('keeps the existing persisted read-model rows and bounds them to 30', () => {
    const stored = buildStoredChannelSnapshotV1({
      snapshot: manyMessageSnapshot(40),
      channelId: CHANNEL,
      revision: 1,
      projectedAt: 10_000,
      cursor: { createdAt: 139, eventIds: ['27'.padStart(64, '0')] },
      identitiesStale: false,
    });
    const events = Object.values(stored.snapshot.rooms[CHANNEL]!.eventJournal);
    expect(events).toHaveLength(CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS);
    expect(events.every((event) => event.type === 'human-message')).toBe(true);
    const view = {
      ...stored,
      lagMs: 12,
      viewer: snapshotViewerOverlay(stored, MEMBER),
      integrity: {
        algorithm: 'sha256' as const,
        scope: 'stored-channel-snapshot-v1' as const,
        digest: channelSnapshotDigest(stored),
      },
    };
    expect(new TextEncoder().encode(`${JSON.stringify(view)}\n`).length).toBeLessThanOrEqual(
      CHANNEL_SNAPSHOT_MAX_BYTES,
    );
  });

  it('counts retained reply context against the transcript row cap', () => {
    const stored = buildStoredChannelSnapshotV1({
      snapshot: manyReplySnapshot(30),
      channelId: CHANNEL,
      revision: 1,
      projectedAt: 10_000,
      cursor: { createdAt: 159, eventIds: ['3b'.padStart(64, '0')] },
      identitiesStale: false,
    });
    const room = stored.snapshot.rooms[CHANNEL]!;
    const transcript = Object.values(room.eventJournal).filter(
      (event) => event.type === 'human-message' || event.type === 'agent-message',
    );
    expect(transcript).toHaveLength(CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS);
    for (const event of transcript) {
      if (!event.reply) continue;
      expect(room.eventJournal[event.reply.eventId]).toBeDefined();
      expect(room.eventJournal[event.reply.rootId]).toBeDefined();
    }
  });

  it('reduces transcript rows against the complete response byte cap', () => {
    const maxBytes = 10_000;
    const stored = buildStoredChannelSnapshotV1({
      snapshot: manyMessageSnapshot(40, 500),
      channelId: CHANNEL,
      revision: 1,
      projectedAt: 10_000,
      cursor: { createdAt: 139, eventIds: ['27'.padStart(64, '0')] },
      identitiesStale: false,
      maxBytes,
    });
    const view = {
      ...stored,
      lagMs: Number.MAX_SAFE_INTEGER,
      viewer: {
        pubkey: 'f'.repeat(64),
        membership: 'active' as const,
        role: 'unknown' as const,
        kind: 'infrastructure' as const,
        approval: 'not-applicable' as const,
      },
      integrity: {
        algorithm: 'sha256' as const,
        scope: 'stored-channel-snapshot-v1' as const,
        digest: 'f'.repeat(64),
      },
    };

    expect(Object.keys(stored.snapshot.rooms[CHANNEL]!.eventJournal).length).toBeLessThan(30);
    expect(new TextEncoder().encode(`${JSON.stringify(view)}\n`).length).toBeLessThanOrEqual(
      maxBytes,
    );
  });

  it('fails closed when the canonical payload is changed after hashing', () => {
    const value = fixture() as Record<string, unknown>;
    const stored = Object.fromEntries(
      Object.entries(value).filter(([key]) => !['lagMs', 'viewer', 'integrity'].includes(key)),
    );
    expect(channelSnapshotDigest(stored as never)).toBe(
      (value.integrity as { digest: string }).digest,
    );
    value.revision = 8;
    expect(guardChannelSnapshotViewV1(value)).toEqual({
      status: 'integrity-halt',
      diagnostic: 'Channel snapshot integrity check failed.',
    });
  });

  it('rejects an incomplete viewer or review envelope even before paint', () => {
    const invalidViewer = fixture() as Record<string, unknown>;
    invalidViewer.viewer = { ...(invalidViewer.viewer as object), role: 'superuser' };
    expect(guardChannelSnapshotViewV1(invalidViewer).status).toBe('integrity-halt');

    const missingReview = fixture() as Record<string, unknown>;
    delete missingReview.review;
    expect(guardChannelSnapshotViewV1(missingReview).status).toBe('integrity-halt');
  });

  it('rejects correctly hashed malformed stored envelope fields', () => {
    const malformedRepository = correctlyHashedMutation((value) => {
      value.repository = {};
    });
    expect(guardChannelSnapshotViewV1(malformedRepository).status).toBe('integrity-halt');

    const malformedReview = correctlyHashedMutation((value) => {
      const review = value.review as Record<string, unknown>;
      review.files = [42];
      review.fileCount = 1;
    });
    expect(guardChannelSnapshotViewV1(malformedReview).status).toBe('integrity-halt');

    const malformedCursor = correctlyHashedMutation((value) => {
      (value.cursor as Record<string, unknown>).eventIds = ['not-an-event-id'];
    });
    expect(guardChannelSnapshotViewV1(malformedCursor).status).toBe('integrity-halt');

    const malformedPersistedRow = correctlyHashedMutation((value) => {
      const snapshot = value.snapshot as Record<string, unknown>;
      const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
      const journal = rooms[CHANNEL]!.eventJournal as Record<string, Record<string, unknown>>;
      journal['1'.repeat(64)]!.body = 42;
    });
    expect(guardChannelSnapshotViewV1(malformedPersistedRow).status).toBe('integrity-halt');

    const unsafeAttachment = correctlyHashedMutation((value) => {
      const snapshot = value.snapshot as Record<string, unknown>;
      const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
      const journal = rooms[CHANNEL]!.eventJournal as Record<string, Record<string, unknown>>;
      journal['1'.repeat(64)]!.attachments = [
        { url: 'file:///private/data', name: 'secret.txt', mimeType: 'text/plain', size: 1 },
      ];
    });
    expect(guardChannelSnapshotViewV1(unsafeAttachment).status).toBe('integrity-halt');

    const invalidReviewSemantics = correctlyHashedMutation((value) => {
      value.review = {
        state: 'ready',
        target: {
          repository: 'lunchboxfortwo/beeline',
          branch: 'main',
          tip: 'not-a-commit',
        },
        files: [''],
        fileCount: 1,
        approvedBy: [],
      };
    });
    expect(guardChannelSnapshotViewV1(invalidReviewSemantics).status).toBe('integrity-halt');

    const danglingReply = correctlyHashedMutation((value) => {
      const snapshot = value.snapshot as Record<string, unknown>;
      const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
      const journal = rooms[CHANNEL]!.eventJournal as Record<string, Record<string, unknown>>;
      journal['1'.repeat(64)]!.reply = {
        channelId: CHANNEL,
        eventId: '1'.repeat(64),
        rootId: 'f'.repeat(64),
      };
    });
    expect(guardChannelSnapshotViewV1(danglingReply).status).toBe('integrity-halt');

    const missingReplyParent = correctlyHashedMutation((value) => {
      const snapshot = value.snapshot as Record<string, unknown>;
      const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
      const journal = rooms[CHANNEL]!.eventJournal as Record<string, Record<string, unknown>>;
      journal['1'.repeat(64)]!.reply = {
        channelId: CHANNEL,
        eventId: 'f'.repeat(64),
        rootId: '1'.repeat(64),
      };
    });
    expect(guardChannelSnapshotViewV1(missingReplyParent).status).toBe('integrity-halt');

    const crossRoomReply = correctlyHashedMutation((value) => {
      const snapshot = value.snapshot as Record<string, unknown>;
      const rooms = snapshot.rooms as Record<string, Record<string, unknown>>;
      const journal = rooms[CHANNEL]!.eventJournal as Record<string, Record<string, unknown>>;
      journal['1'.repeat(64)]!.reply = {
        channelId: 'f0000000-0000-4000-8000-000000000001',
        eventId: '1'.repeat(64),
        rootId: '1'.repeat(64),
      };
    });
    expect(guardChannelSnapshotViewV1(crossRoomReply).status).toBe('integrity-halt');
  });

  it('projects review manifests and human approval through shared typed facts', () => {
    const owner = createIdentity('review-owner');
    const agent = createIdentity('review-agent');
    const tip = '1'.repeat(40);
    const base = '2'.repeat(40);
    const patchId = '3'.repeat(40);
    const signed = (
      identity: typeof owner,
      createdAt: number,
      kind: number,
      tags: string[][],
      content: string,
    ) =>
      signEvent(
        { pubkey: identity.publicKey, created_at: createdAt, kind, tags, content },
        identity.secretKey,
      );
    const events = [
      signed(
        agent,
        1,
        9,
        [
          ['h', CHANNEL],
          ['t', 'merge-ready'],
          ['repo', 'lunchboxfortwo/beeline'],
          ['branch', 'main'],
          ['tip', tip],
          ['patch-id', patchId],
        ],
        'Ready for review',
      ),
      signed(
        agent,
        2,
        30078,
        [
          ['h', CHANNEL],
          ['d', `${CHANNEL}:${tip}:manifest:0`],
          ['t', 'change-review-manifest'],
          ['generation', 'transactional-v1'],
          ['tip', tip],
          ['chunk', '0'],
          ['chunks', '1'],
        ],
        JSON.stringify({
          version: 1,
          base,
          tip,
          files: [{ path: 'apps/push-gateway/src/server.ts', status: 'modified' }],
        }),
      ),
      signed(
        agent,
        3,
        30078,
        [
          ['h', CHANNEL],
          ['d', `${CHANNEL}:${tip}:complete`],
          ['t', 'change-review-complete'],
          ['generation', 'transactional-v1'],
          ['tip', tip],
        ],
        JSON.stringify({
          version: 1,
          base,
          tip,
          patchId,
          summary: 'Build snapshot server',
          manifestChunks: 1,
          fileCount: 1,
        }),
      ),
      signed(
        owner,
        4,
        9,
        [
          ['h', CHANNEL],
          ['t', 'buzz-merge-approval'],
          ['repo', 'lunchboxfortwo/beeline'],
          ['branch', 'main'],
          ['tip', tip],
        ],
        'APPROVE',
      ),
      signed(
        agent,
        5,
        9,
        [
          ['h', CHANNEL],
          ['t', 'buzz-merge-approval-ack'],
          ['decision', 'accepted'],
          ['state', 'landing'],
          ['approval', 'approval-1'],
        ],
        'Landing',
      ),
    ];
    const identities = {
      [owner.publicKey]: {
        kind: 'human' as const,
        pubkey: owner.publicKey as Pubkey,
        revision: 'owner',
      },
      [agent.publicKey]: {
        kind: 'agent' as const,
        pubkey: agent.publicKey as Pubkey,
        revision: 'agent',
      },
    };
    const parsed = parseRelayEvents(events, {
      workspaceId: 'verified-workspace',
      expectedChannelId: CHANNEL,
      identities,
      channelAdmins: { [CHANNEL]: [owner.publicKey] },
    });
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({
        workspaceId: 'verified-workspace',
        identities: Object.values(identities),
      }),
      parsed,
    );

    expect(selectReviewSummary(snapshot, CHANNEL)).toEqual({
      state: 'landing',
      target: {
        repository: 'lunchboxfortwo/beeline',
        branch: 'main',
        tip,
        patchId,
      },
      files: ['apps/push-gateway/src/server.ts'],
      fileCount: 1,
      previewSummary: 'Build snapshot server',
      approvedBy: [owner.publicKey],
      daemonAcknowledgement: {
        approvalId: 'approval-1',
        decision: 'accepted',
        state: 'landing',
      },
    });

    const successor = createIdentity('review-successor');
    const stored = buildStoredChannelSnapshotV1({
      snapshot,
      channelId: CHANNEL,
      revision: 1,
      projectedAt: 10,
      cursor: { createdAt: 5, eventIds: [events.at(-1)!.id] },
      identitiesStale: false,
      canonicalPubkeys: { [owner.publicKey]: successor.publicKey },
    });
    expect(stored.review.approvedBy).toEqual([successor.publicKey]);
    expect(snapshotViewerOverlay(stored, successor.publicKey).approval).toBe('approved');
  });
});
