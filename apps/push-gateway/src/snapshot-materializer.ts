import {
  boundChannelWorkspaceSnapshot,
  buildStoredChannelSnapshotV1,
  canonicalizeWorkspaceMembership,
  CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS,
  channelSnapshotDigest,
  commitRoomCoverage,
  createWorkspaceSnapshot,
  deriveRelayAuthorityFacts,
  parseRelayEvents,
  reduceWorkspaceEvents,
  selectTranscript,
  unresolvedReplyParentIds,
  type ChannelSnapshotCursorV1,
  type IdentityRecord,
  type ParseAuthority,
  type Pubkey,
  type ReadEvent,
} from '@beeline/buzz-client';
import type { SnapshotSuccessionClient, SuccessionResolution } from './succession.js';
import {
  ChannelSnapshotStore,
  type ChannelMessagePage,
  type CurrentChannelMember,
  type DirtyChannelClaim,
  type ProjectionInput,
} from './snapshot-store.js';

export interface SnapshotProjectionReader {
  loadProjectionInput(claim: DirtyChannelClaim): Promise<ProjectionInput | null>;
  loadMessagePage(
    tenantId: string,
    channelId: string,
    cursor?: ProjectionInput['messageCursor'],
  ): Promise<ChannelMessagePage>;
  loadMessageEvents(
    tenantId: string,
    channelId: string,
    eventIds: readonly string[],
  ): Promise<readonly import('@beeline/nostr').NostrEvent[]>;
  loadCurrentMembers(
    tenantId: string,
    channelIds: readonly string[],
  ): Promise<readonly CurrentChannelMember[]>;
  loadMemberHistory(
    tenantId: string,
    channelIds: readonly string[],
  ): Promise<readonly CurrentChannelMember[]>;
  loadIdentityEvents(
    tenantId: string,
    pubkeys: readonly string[],
  ): Promise<readonly import('@beeline/nostr').NostrEvent[]>;
  nextRevision(tenantId: string, channelId: string): Promise<number>;
}

export interface SnapshotMaterializerStore extends SnapshotProjectionReader {
  enqueueBackfill(): Promise<void>;
  claimDirty(
    limit: number,
    leaseMs: number,
    coalesceMs?: number,
  ): Promise<readonly DirtyChannelClaim[]>;
  withProjectionBoundary<T>(work: (reader: ChannelSnapshotStore) => Promise<T>): Promise<T>;
  continueScan(
    claim: DirtyChannelClaim,
    continuation: {
      readonly cursor: NonNullable<ProjectionInput['messageCursor']>;
      readonly eventIds: readonly string[];
    },
  ): Promise<void>;
  continueRepositoryScan(
    claim: DirtyChannelClaim,
    cursor: NonNullable<ProjectionInput['repositoryCursor']>,
    repositoryEventId?: string,
  ): Promise<void>;
  recordRepositoryEvent(claim: DirtyChannelClaim, repositoryEventId?: string): Promise<void>;
  complete(
    claim: DirtyChannelClaim,
    payload: ReturnType<typeof buildStoredChannelSnapshotV1>,
    digest: string,
  ): Promise<void>;
  discard(claim: DirtyChannelClaim): Promise<void>;
  fail(claim: DirtyChannelClaim, error: unknown): Promise<void>;
}

type SnapshotProjectionResult =
  | { readonly kind: 'discard' }
  | {
      readonly kind: 'repository-continuation';
      readonly input: ProjectionInput;
      readonly repositoryEventId?: string;
    }
  | {
      readonly kind: 'message-continuation';
      readonly input: ProjectionInput;
      readonly cursor: NonNullable<ProjectionInput['messageCursor']>;
      readonly eventIds: readonly string[];
      readonly pages: number;
    }
  | {
      readonly kind: 'complete';
      readonly input: ProjectionInput;
      readonly payload: ReturnType<typeof buildStoredChannelSnapshotV1>;
      readonly digest: string;
      readonly repositoryEventId?: string;
      readonly quarantines: number;
      readonly identitiesStale: boolean;
    };

export interface SnapshotMaterializerOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly burstCoalesceMs?: number;
  readonly maxMessagePagesPerClaim?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

function currentMemberPubkeys(members: readonly CurrentChannelMember[]): Set<string> {
  return new Set(members.map((member) => member.pubkey));
}

function identityAuthority(
  members: readonly CurrentChannelMember[],
  historicalAuthors: readonly string[],
  hints: Readonly<Record<string, IdentityRecord>>,
  succession: SuccessionResolution,
): Readonly<Record<string, IdentityRecord>> {
  const currentMembers = currentMemberPubkeys(members);
  const identities: Record<string, IdentityRecord> = {};
  for (const author of historicalAuthors) {
    if (hints[author]) identities[author] = hints[author];
  }
  for (const member of currentMembers) {
    identities[member] =
      hints[member] ??
      ({ kind: 'human', pubkey: member as Pubkey, revision: `member:${member}` } as const);
  }
  for (const [historical, current] of Object.entries(succession.mappings)) {
    if (!currentMembers.has(current)) continue;
    const currentIdentity = identities[current] ?? hints[current];
    if (!currentIdentity) continue;
    identities[historical] = {
      ...currentIdentity,
      pubkey: historical as Pubkey,
      revision:
        historical === current
          ? currentIdentity.revision
          : `succession:${historical}:${current}:${currentIdentity.revision}`,
    };
  }
  return identities;
}

function aliasAuthority(
  values: Readonly<Record<string, readonly string[]>>,
  succession: SuccessionResolution,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(values).map(([channelId, pubkeys]) => {
      const expanded = new Set(pubkeys);
      for (const [historical, current] of Object.entries(succession.mappings)) {
        if (expanded.has(current)) expanded.add(historical);
      }
      return [channelId, [...expanded]];
    }),
  );
}

function currentOwnerAuthority(
  channelCreators: Readonly<Record<string, string>>,
  succession: SuccessionResolution,
  members: readonly CurrentChannelMember[],
): Readonly<Record<string, readonly string[]>> {
  const currentMembers = currentMemberPubkeys(members);
  return Object.fromEntries(
    Object.entries(channelCreators).map(([channelId, creator]) => {
      const owners = new Set([creator]);
      const successor = succession.mappings[creator];
      if (successor && currentMembers.has(successor)) owners.add(successor);
      return [channelId, [...owners]];
    }),
  );
}

/** Durable, fair, bounded channel-snapshot rebuild worker. */
export class ChannelSnapshotMaterializer {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly burstCoalesceMs: number;
  private readonly maxMessagePagesPerClaim: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = true;
  private warmed = false;

  constructor(
    private readonly store: SnapshotMaterializerStore,
    private readonly succession: SnapshotSuccessionClient,
    options: SnapshotMaterializerOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.min(16, options.batchSize ?? 4));
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.burstCoalesceMs = options.burstCoalesceMs ?? 75;
    this.maxMessagePagesPerClaim = Math.max(
      1,
      Math.min(16, Math.floor(options.maxMessagePagesPerClaim ?? 4)),
    );
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
  }

  get ready(): boolean {
    return this.warmed;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.store.enqueueBackfill();
    this.schedule(this.burstCoalesceMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One bounded claim pass; public so deterministic tests can drive fairness. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claims = await this.store.claimDirty(
        this.batchSize,
        this.leaseMs,
        this.burstCoalesceMs,
      );
      await Promise.all(claims.map((claim) => this.rebuild(claim)));
      this.warmed = true;
      return claims.length;
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .then((claimed) => this.schedule(claimed >= this.batchSize ? 0 : this.pollIntervalMs))
        .catch((error) => {
          this.log(
            `[snapshot] worker pass failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
          );
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
  }

  private async rebuild(claim: DirtyChannelClaim): Promise<void> {
    const startedAt = this.now();
    try {
      const result = await this.store.withProjectionBoundary((reader) =>
        this.project(claim, reader),
      );
      if (result.kind === 'discard') {
        await this.store.discard(claim);
      } else if (result.kind === 'repository-continuation') {
        await this.store.continueRepositoryScan(
          claim,
          result.input.repositoryCursor!,
          result.repositoryEventId,
        );
        this.log(
          `[snapshot] yielded tenant=${result.input.tenantId} channel=${result.input.channelId} repository_scan=true`,
        );
      } else if (result.kind === 'message-continuation') {
        await this.store.continueScan(claim, {
          cursor: result.cursor,
          eventIds: result.eventIds,
        });
        this.log(
          `[snapshot] yielded tenant=${result.input.tenantId} channel=${result.input.channelId} pages=${result.pages} retained=${result.eventIds.length}`,
        );
      } else {
        await this.store.recordRepositoryEvent(claim, result.repositoryEventId);
        await this.store.complete(claim, result.payload, result.digest);
        const durationMs = this.now() - startedAt;
        const bytes = Buffer.byteLength(JSON.stringify(result.payload));
        this.log(
          `[snapshot] rebuilt tenant=${result.input.tenantId} channel=${result.input.channelId} duration_ms=${durationMs} bytes=${bytes} quarantines=${result.quarantines} identities_stale=${result.identitiesStale}`,
        );
      }
    } catch (error) {
      await this.store.fail(claim, error);
      this.log(
        `[snapshot] rebuild failed tenant=${claim.tenantId} channel=${claim.channelId} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private async project(
    claim: DirtyChannelClaim,
    reader: SnapshotProjectionReader,
  ): Promise<SnapshotProjectionResult> {
    const input = await reader.loadProjectionInput(claim);
    if (!input) return { kind: 'discard' };
    const [members, memberHistory] = await Promise.all([
      reader.loadCurrentMembers(input.tenantId, input.channelIds),
      reader.loadMemberHistory(input.tenantId, input.channelIds),
    ]);
    const historicalMessagePubkeys = Object.fromEntries(
      input.channelIds.map((channelId) => [
        channelId,
        [
          ...new Set(
            memberHistory
              .filter((member) => member.channelId === channelId)
              .map((member) => member.pubkey),
          ),
        ],
      ]),
    );
    const relayEvents = new Map(input.events.map((event) => [event.id, event]));
    let messageCursor = input.messageCursor;
    let messagesExhausted = input.messagesExhausted;
    let messagePagesRead = 1;
    let repositoryEventId = input.repositoryEventId;
    const attemptedReplyParentIds = new Set<string>();
    let projection:
      | {
          readonly parsed: readonly ReadEvent[];
          readonly cursor: ChannelSnapshotCursorV1;
          readonly snapshot: ReturnType<typeof createWorkspaceSnapshot>;
          readonly succession: SuccessionResolution;
        }
      | undefined;
    while (true) {
      const currentEvents = [...relayEvents.values()];
      const initialFacts = deriveRelayAuthorityFacts(currentEvents);
      const identityKeys = [
        ...new Set([
          ...members.map((member) => member.pubkey),
          ...initialFacts.memberPubkeys,
          ...currentEvents.map((event) => event.pubkey),
        ]),
      ];
      const [identityEvents, succession] = await Promise.all([
        reader.loadIdentityEvents(input.tenantId, identityKeys),
        this.succession.resolve(input.tenantId, identityKeys),
      ]);
      const events = [
        ...new Map(
          [...currentEvents, ...identityEvents].map((event) => [event.id, event]),
        ).values(),
      ];
      const facts = deriveRelayAuthorityFacts(events);
      const workspaceId = input.channelIds
        .map((channelId) => facts.workspaceIdsByChannel[channelId])
        .find((candidate): candidate is string => Boolean(candidate));
      if (!workspaceId) throw new Error('snapshot projection lacks a verified Workspace id');
      const identities = identityAuthority(
        members,
        currentEvents.map((event) => event.pubkey),
        facts.identityHints,
        succession,
      );
      const authority: ParseAuthority = {
        workspaceId,
        allowedChannelIds: input.channelIds,
        identities,
        channelCreators: facts.channelCreators,
        channelOwners: currentOwnerAuthority(facts.channelCreators, succession, members),
        channelAdmins: aliasAuthority(facts.channelAdmins, succession),
        trustedProjectionPubkeys: facts.trustedProjectionPubkeys,
        historicalMessagePubkeys,
      };
      const parsed = parseRelayEvents(events, authority);
      repositoryEventId = parsed
        .filter(
          (event) =>
            event.type === 'control' &&
            event.payload.kind === 'repository' &&
            'channelId' in event &&
            event.channelId === input.repositoryChannelId,
        )
        .sort(
          (a, b) =>
            (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
            (a.eventId ?? '').localeCompare(b.eventId ?? ''),
        )
        .at(-1)?.eventId;
      if (!input.repositoriesExhausted) {
        if (!input.repositoryCursor) {
          throw new Error('snapshot repository scan lost its continuation cursor');
        }
        return {
          kind: 'repository-continuation',
          input,
          ...(repositoryEventId ? { repositoryEventId } : {}),
        };
      }
      const cursor = input.cursor;
      let snapshot = reduceWorkspaceEvents(
        createWorkspaceSnapshot({ workspaceId, identities: Object.values(identities) }),
        parsed,
      );
      snapshot = canonicalizeWorkspaceMembership(
        snapshot,
        Object.fromEntries(
          input.channelIds.map((channelId) => [
            channelId,
            members
              .filter((member) => member.channelId === channelId)
              .map((member) => member.pubkey),
          ]),
        ),
        succession.mappings,
      );
      projection = { parsed, cursor, snapshot, succession };
      const unresolvedParentIds = unresolvedReplyParentIds(currentEvents, parsed).filter(
        (eventId) => !relayEvents.has(eventId) && !attemptedReplyParentIds.has(eventId),
      );
      if (unresolvedParentIds.length > 0 && messagePagesRead < this.maxMessagePagesPerClaim) {
        for (const eventId of unresolvedParentIds) attemptedReplyParentIds.add(eventId);
        const parents = await reader.loadMessageEvents(
          input.tenantId,
          input.channelId,
          unresolvedParentIds,
        );
        messagePagesRead += 1;
        if (parents.length > 0) {
          for (const event of parents) relayEvents.set(event.id, event);
          continue;
        }
      }
      const persistedSnapshot = boundChannelWorkspaceSnapshot(
        snapshot,
        input.channelId,
        CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS,
      );
      const transcript = selectTranscript(persistedSnapshot, input.channelId, {
        limit: CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS,
      });
      if (messagesExhausted || transcript.length >= CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS) {
        break;
      }
      if (messagePagesRead >= this.maxMessagePagesPerClaim) {
        if (!messageCursor) throw new Error('snapshot message scan lost its continuation cursor');
        const rawById = new Map(currentEvents.map((event) => [event.id, event]));
        const carryIds = new Set<string>(
          transcript.map((item) => item.id).filter((eventId) => rawById.has(eventId)),
        );
        const persistedRoom = persistedSnapshot.rooms[input.channelId];
        for (const item of transcript) {
          const event = persistedRoom?.eventJournal[item.id];
          if (
            (event?.type === 'human-message' || event?.type === 'agent-message') &&
            event.reply?.eventId &&
            rawById.has(event.reply.eventId)
          ) {
            carryIds.add(event.reply.eventId);
          }
        }
        const eventIds = [...carryIds]
          .sort((left, right) => {
            const leftEvent = rawById.get(left)!;
            const rightEvent = rawById.get(right)!;
            return rightEvent.created_at - leftEvent.created_at || left.localeCompare(right);
          })
          .slice(0, CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS * 2);
        return {
          kind: 'message-continuation',
          input,
          cursor: messageCursor,
          eventIds,
          pages: messagePagesRead,
        };
      }
      const page = await reader.loadMessagePage(input.tenantId, input.channelId, messageCursor);
      for (const event of page.events) relayEvents.set(event.id, event);
      messageCursor = page.cursor;
      messagesExhausted = page.exhausted;
      messagePagesRead += 1;
    }
    if (!projection) throw new Error('snapshot projection did not run');
    const { parsed, cursor, succession } = projection;
    let { snapshot } = projection;
    snapshot = commitRoomCoverage(snapshot, input.channelId, {
      epoch: claim.dirtyRevision,
      initialBackfillComplete: true,
      oldest: Math.min(...parsed.map((event) => event.createdAt ?? cursor.createdAt)),
      newest: cursor.createdAt,
    });
    if (!snapshot.rooms[input.channelId]) {
      throw new Error('snapshot projection did not materialize the requested Room');
    }
    const revision = await reader.nextRevision(input.tenantId, input.channelId);
    const payload = buildStoredChannelSnapshotV1({
      snapshot,
      channelId: input.channelId,
      revision,
      projectedAt: this.now(),
      cursor,
      identitiesStale: succession.stale,
      canonicalPubkeys: succession.mappings,
    });
    const digest = channelSnapshotDigest(payload);
    return {
      kind: 'complete',
      input,
      payload,
      digest,
      ...(repositoryEventId ? { repositoryEventId } : {}),
      quarantines: snapshot.diagnostics.length,
      identitiesStale: succession.stale,
    };
  }
}

export function createSnapshotMaterializer(
  store: ChannelSnapshotStore,
  succession: SnapshotSuccessionClient,
  options?: SnapshotMaterializerOptions,
): ChannelSnapshotMaterializer {
  return new ChannelSnapshotMaterializer(store, succession, options);
}
