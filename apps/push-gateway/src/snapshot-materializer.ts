import {
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

export interface SnapshotMaterializerStore {
  enqueueBackfill(): Promise<void>;
  claimDirty(
    limit: number,
    leaseMs: number,
    coalesceMs?: number,
  ): Promise<readonly DirtyChannelClaim[]>;
  loadProjectionInput(claim: DirtyChannelClaim): Promise<ProjectionInput | null>;
  loadMessagePage(
    tenantId: string,
    channelId: string,
    cursor?: ProjectionInput['messageCursor'],
  ): Promise<ChannelMessagePage>;
  loadCurrentMembers(
    tenantId: string,
    channelIds: readonly string[],
  ): Promise<readonly CurrentChannelMember[]>;
  loadIdentityEvents(
    tenantId: string,
    pubkeys: readonly string[],
  ): Promise<readonly import('@beeline/nostr').NostrEvent[]>;
  nextRevision(tenantId: string, channelId: string): Promise<number>;
  complete(
    claim: DirtyChannelClaim,
    payload: ReturnType<typeof buildStoredChannelSnapshotV1>,
    digest: string,
  ): Promise<void>;
  discard(claim: DirtyChannelClaim): Promise<void>;
  fail(claim: DirtyChannelClaim, error: unknown): Promise<void>;
}

export interface SnapshotMaterializerOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly burstCoalesceMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

function currentMemberPubkeys(members: readonly CurrentChannelMember[]): Set<string> {
  return new Set(members.map((member) => member.pubkey));
}

function identityAuthority(
  members: readonly CurrentChannelMember[],
  hints: Readonly<Record<string, IdentityRecord>>,
  succession: SuccessionResolution,
): Readonly<Record<string, IdentityRecord>> {
  const currentMembers = currentMemberPubkeys(members);
  const identities: Record<string, IdentityRecord> = {};
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

function relayCursor(events: readonly ReadEvent[], channelId: string) {
  const included = events.filter(
    (
      event,
    ): event is Exclude<ReadEvent, { readonly type: 'unknown' }> & { readonly scope: 'channel' } =>
      event.type !== 'unknown' && event.scope === 'channel' && event.channelId === channelId,
  );
  const createdAt = Math.max(...included.map((event) => event.createdAt), -1);
  if (createdAt < 0) throw new Error('snapshot projection has no inclusive channel cursor');
  return {
    createdAt,
    eventIds: included
      .filter((event) => event.createdAt === createdAt)
      .map((event) => event.eventId)
      .sort(),
  };
}

/** Durable, fair, bounded channel-snapshot rebuild worker. */
export class ChannelSnapshotMaterializer {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly burstCoalesceMs: number;
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
      const input = await this.store.loadProjectionInput(claim);
      if (!input) {
        await this.store.discard(claim);
        return;
      }
      const members = await this.store.loadCurrentMembers(input.tenantId, input.channelIds);
      const relayEvents = new Map(input.events.map((event) => [event.id, event]));
      let messageCursor = input.messageCursor;
      let messagesExhausted = input.messagesExhausted;
      let projection:
        | {
            readonly parsed: readonly ReadEvent[];
            readonly cursor: ReturnType<typeof relayCursor>;
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
          this.store.loadIdentityEvents(input.tenantId, identityKeys),
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
        const identities = identityAuthority(members, facts.identityHints, succession);
        const authority: ParseAuthority = {
          workspaceId,
          allowedChannelIds: input.channelIds,
          identities,
          channelCreators: facts.channelCreators,
          channelAdmins: aliasAuthority(facts.channelAdmins, succession),
          trustedProjectionPubkeys: facts.trustedProjectionPubkeys,
        };
        const parsed = parseRelayEvents(events, authority);
        const cursor = relayCursor(parsed, input.channelId);
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
        if (
          messagesExhausted ||
          selectTranscript(snapshot, input.channelId, {
            limit: CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS,
          }).length >= CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS
        ) {
          break;
        }
        const page = await this.store.loadMessagePage(
          input.tenantId,
          input.channelId,
          messageCursor,
        );
        for (const event of page.events) relayEvents.set(event.id, event);
        messageCursor = page.cursor;
        messagesExhausted = page.exhausted;
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
      const revision = await this.store.nextRevision(input.tenantId, input.channelId);
      const payload = buildStoredChannelSnapshotV1({
        snapshot,
        channelId: input.channelId,
        revision,
        projectedAt: this.now(),
        cursor,
        identitiesStale: succession.stale,
      });
      const digest = channelSnapshotDigest(payload);
      await this.store.complete(claim, payload, digest);
      const durationMs = this.now() - startedAt;
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      const quarantines = snapshot.diagnostics.length;
      this.log(
        `[snapshot] rebuilt tenant=${input.tenantId} channel=${input.channelId} duration_ms=${durationMs} bytes=${bytes} quarantines=${quarantines} identities_stale=${succession.stale}`,
      );
    } catch (error) {
      await this.store.fail(claim, error);
      this.log(
        `[snapshot] rebuild failed tenant=${claim.tenantId} channel=${claim.channelId} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
}

export function createSnapshotMaterializer(
  store: ChannelSnapshotStore,
  succession: SnapshotSuccessionClient,
  options?: SnapshotMaterializerOptions,
): ChannelSnapshotMaterializer {
  return new ChannelSnapshotMaterializer(store, succession, options);
}
