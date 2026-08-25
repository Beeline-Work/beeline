/**
 * Human-device half of the P1 permission ledger.
 *
 * Approval and execution deliberately share one durable outbox record. Room
 * creation uses the request's reserved UUID and remains human-authored; a
 * crash or two-admin race can therefore reconcile, never mint a second Room.
 */
import type { NostrEvent } from '@beeline/nostr';
import {
  buildAgentAccessConfig,
  buildPermissionDecision,
  buildPermissionExecution,
  buildPermissionRevocation,
  defaultPermissionGrantEnvelope,
  foldPermissionLedger,
  parsePermissionDecision,
  parsePermissionExecution,
  parsePermissionRequest,
  parsePermissionRevocation,
  permissionActionId,
  verifyPermissionAction,
  type AgentAccessPolicyV1,
  type Identity,
  type ParsedPermissionRequest,
  type PermissionConcreteAction,
  type PermissionFreshReader,
  type PermissionGrantEnvelopeV1,
  type PermissionScope,
  type RepositoryBinding,
} from '@beeline/buzz-client';

export interface PermissionEventPublisher {
  publish(event: NostrEvent): Promise<unknown>;
}

export interface RoomCreateClient extends PermissionEventPublisher {
  createChannel(
    name: string,
    options: {
      channelId: string;
      visibility: string;
      communityId: string;
      repository?: RepositoryBinding;
      extraTags?: string[][];
      mirrorCommunityMembers: false;
    },
  ): Promise<string>;
  setMemberRole(channelId: string, pubkey: string, role: 'member'): Promise<unknown>;
  attachAgentToChannel(channelId: string, pubkey: string, communityId: string): Promise<unknown>;
}

export interface FactoryOutboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface RoomCreateOutboxItem {
  version: 1;
  request: NostrEvent;
  decision: NostrEvent;
  action: PermissionConcreteAction;
  attempt: number;
  state: 'queued' | 'needs-human';
}

const HEX_64 = /^[0-9a-f]{64}$/;

export function roomCreateOutboxKey(actionId: string): string {
  if (!/^pa_[0-9a-f]{64}$/.test(actionId)) throw new Error('invalid permission action id');
  return `beeline:factory:room-create:v1:${actionId}`;
}

export class RoomCreateOutbox {
  constructor(private readonly storage: FactoryOutboxStorage) {}

  async put(item: RoomCreateOutboxItem): Promise<void> {
    await this.storage.setItem(roomCreateOutboxKey(item.action.actionId), JSON.stringify(item));
  }

  async get(actionId: string): Promise<RoomCreateOutboxItem | undefined> {
    const raw = await this.storage.getItem(roomCreateOutboxKey(actionId));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as RoomCreateOutboxItem;
      if (
        value.version !== 1 ||
        !value.request ||
        !value.decision ||
        !value.action ||
        value.action.actionId !== actionId ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt < 1 ||
        !['queued', 'needs-human'].includes(value.state)
      ) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  async remove(actionId: string): Promise<void> {
    await this.storage.removeItem(roomCreateOutboxKey(actionId));
  }
}

export type ExactRoomState = 'missing' | 'exact' | 'conflict';

export interface RoomCreateExecutorDependencies {
  identity: Identity;
  reader: PermissionFreshReader;
  client: RoomCreateClient;
  outbox: RoomCreateOutbox;
  /** Fresh relay comparison of creator, immutable scope, and exact roster. */
  inspectRoomFresh(
    scope: Extract<PermissionScope, { type: 'room.create' }>,
  ): Promise<ExactRoomState>;
  /** Resolve the credential-free binding named by an exact permission scope. */
  resolveRepositoryBinding?(key: string): Promise<RepositoryBinding | undefined>;
  now?: () => number;
}

export type RoomCreateExecutionResult =
  | { status: 'succeeded'; roomId: string; reconciled: boolean }
  | { status: 'already-succeeded'; roomId: string }
  | { status: 'refused'; reason: string; terminal: boolean }
  | { status: 'unknown'; reason: string };

function roomCreateAction(
  identity: Identity,
  request: ParsedPermissionRequest,
  grantEventId: string,
): PermissionConcreteAction {
  if (request.value.scope.type !== 'room.create') throw new Error('request is not room.create');
  const actionId = permissionActionId(request.value.scope, request.event.id, 0);
  return {
    permissionId: request.value.permissionId,
    requestEventId: request.event.id,
    grantEventId,
    ordinal: 0,
    actionId,
    idempotencyKey: `room-create:${request.value.scope.roomId}`,
    workspaceId: request.value.workspaceId,
    roomId: request.value.roomId,
    scope: request.value.scope,
    executor: 'human-device',
    executorPubkey: identity.publicKey,
    charge: { uses: 1 },
  };
}

function executionEvent(
  identity: Identity,
  request: ParsedPermissionRequest,
  item: RoomCreateOutboxItem,
  status: 'started' | 'succeeded' | 'failed' | 'unknown',
  at: number,
  result?: string,
): NostrEvent {
  return buildPermissionExecution(identity, request, {
    version: 1,
    permissionId: item.action.permissionId,
    grantEventId: item.action.grantEventId,
    actionId: item.action.actionId,
    idempotencyKey: item.action.idempotencyKey,
    attempt: item.attempt,
    status,
    at,
    ...(status === 'started' || status === 'succeeded' ? { charge: item.action.charge } : {}),
    ...(result ? { result: result.slice(0, 600) } : {}),
  });
}

async function createExactRoom(
  dependencies: RoomCreateExecutorDependencies,
  scope: Extract<PermissionScope, { type: 'room.create' }>,
  humanPubkey: string,
): Promise<void> {
  const repository = scope.repository
    ? await dependencies.resolveRepositoryBinding?.(scope.repository.key)
    : undefined;
  if (scope.repository && (!repository || repository.key !== scope.repository.key)) {
    throw new Error('approved repository binding is unavailable');
  }
  const roomId = await dependencies.client.createChannel(scope.name, {
    channelId: scope.roomId,
    visibility: scope.visibility,
    communityId: scope.workspaceId,
    ...(repository ? { repository } : {}),
    ...(scope.repository ? { extraTags: [['repo-target', scope.repository.targetBranch]] } : {}),
    mirrorCommunityMembers: false,
  });
  if (roomId !== scope.roomId) throw new Error('relay returned a different Room id');
  for (const pubkey of scope.participantPubkeys) {
    if (pubkey === humanPubkey) continue;
    await dependencies.client.setMemberRole(scope.roomId, pubkey, 'member');
  }
  for (const pubkey of scope.agentPubkeys) {
    await dependencies.client.attachAgentToChannel(scope.roomId, pubkey, scope.workspaceId);
  }
}

/** Build the default standing grant and persist it before the relay write. */
export async function grantAndQueueRoomCreate(input: {
  identity: Identity;
  requestEvent: NostrEvent;
  client: PermissionEventPublisher;
  outbox: RoomCreateOutbox;
  now?: number;
  grant?: PermissionGrantEnvelopeV1;
}): Promise<RoomCreateOutboxItem> {
  const request = parsePermissionRequest(input.requestEvent);
  if (!request || request.value.scope.type !== 'room.create')
    throw new Error('invalid Room request');
  const decidedAt = input.now ?? Math.floor(Date.now() / 1_000);
  const decision = buildPermissionDecision(input.identity, request, {
    version: 1,
    permissionId: request.value.permissionId,
    requestEventId: request.event.id,
    decision: 'grant',
    decidedAt,
    grant: input.grant ?? defaultPermissionGrantEnvelope(request.value.scope, decidedAt),
  });
  const item: RoomCreateOutboxItem = {
    version: 1,
    request: input.requestEvent,
    decision,
    action: roomCreateAction(input.identity, request, decision.id),
    attempt: 1,
    state: 'queued',
  };
  await input.outbox.put(item);
  await input.client.publish(decision);
  return item;
}

/** Generic approval-card decision path for standing envelopes and Tier 2 asks. */
export async function publishPermissionDecisionFromCard(input: {
  identity: Identity;
  requestEvent: NostrEvent;
  client: PermissionEventPublisher;
  decision: 'grant' | 'deny';
  grant?: PermissionGrantEnvelopeV1;
  note?: string;
  now?: number;
}): Promise<NostrEvent> {
  const request = parsePermissionRequest(input.requestEvent);
  if (!request) throw new Error('invalid permission request');
  const decidedAt = input.now ?? Math.floor(Date.now() / 1_000);
  const event = buildPermissionDecision(input.identity, request, {
    version: 1,
    permissionId: request.value.permissionId,
    requestEventId: request.event.id,
    decision: input.decision,
    decidedAt,
    ...(input.decision === 'grant'
      ? { grant: input.grant ?? defaultPermissionGrantEnvelope(request.value.scope, decidedAt) }
      : {}),
    ...(input.note ? { note: input.note } : {}),
  });
  await input.client.publish(event);
  return event;
}

/** Instant revocation action exposed by every granted permission card. */
export async function publishPermissionRevocationFromCard(input: {
  identity: Identity;
  requestEvent: NostrEvent;
  grantEventId: string;
  client: PermissionEventPublisher;
  reason: string;
  note?: string;
  now?: number;
}): Promise<NostrEvent> {
  const request = parsePermissionRequest(input.requestEvent);
  if (!request) throw new Error('invalid permission request');
  const event = buildPermissionRevocation(input.identity, request, {
    version: 1,
    permissionId: request.value.permissionId,
    grantEventId: input.grantEventId,
    revokedAt: input.now ?? Math.floor(Date.now() / 1_000),
    reason: input.reason,
    ...(input.note ? { note: input.note } : {}),
  });
  await input.client.publish(event);
  return event;
}

/**
 * Resume one deterministic Room create. Unknown external actions never retry;
 * this narrow executor may continue only after inspecting the fixed Room UUID.
 */
export async function executeQueuedRoomCreate(
  dependencies: RoomCreateExecutorDependencies,
  item: RoomCreateOutboxItem,
): Promise<RoomCreateExecutionResult> {
  const request = parsePermissionRequest(item.request);
  const decision = request ? parsePermissionDecision(item.decision, request) : undefined;
  if (
    !request ||
    request.value.scope.type !== 'room.create' ||
    !decision ||
    decision.event.id !== item.action.grantEventId ||
    item.action.executorPubkey !== dependencies.identity.publicKey
  ) {
    return { status: 'refused', reason: 'invalid-outbox-item', terminal: true };
  }
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const verification = await verifyPermissionAction({
    reader: dependencies.reader,
    action: item.action,
    now,
  });
  if (!verification.authorized) {
    if (verification.reason === 'action-already-succeeded') {
      await dependencies.outbox.remove(item.action.actionId);
      return { status: 'already-succeeded', roomId: request.value.scope.roomId };
    }
    // A started receipt is ambiguous for generic providers, but Room creation
    // has a deterministic UUID and an exact immutable state probe.
    if (verification.reason !== 'action-outcome-unknown') {
      return {
        status: 'refused',
        reason: verification.reason,
        terminal: verification.terminal,
      };
    }
  }

  const before = await dependencies.inspectRoomFresh(request.value.scope);
  if (before === 'conflict') {
    item.state = 'needs-human';
    await dependencies.outbox.put(item);
    return { status: 'unknown', reason: 'reserved-room-id-conflict' };
  }
  if (before === 'exact') {
    await dependencies.client.publish(
      executionEvent(
        dependencies.identity,
        request,
        item,
        'succeeded',
        now,
        request.value.scope.roomId,
      ),
    );
    await dependencies.outbox.remove(item.action.actionId);
    return { status: 'succeeded', roomId: request.value.scope.roomId, reconciled: true };
  }

  if (verification.authorized) {
    await dependencies.client.publish(
      executionEvent(dependencies.identity, request, item, 'started', now),
    );
  }
  try {
    await createExactRoom(dependencies, request.value.scope, dependencies.identity.publicKey);
  } catch (error) {
    const after = await dependencies.inspectRoomFresh(request.value.scope);
    if (after !== 'exact') {
      const reason = error instanceof Error ? error.message : String(error);
      item.state = 'needs-human';
      await dependencies.outbox.put(item);
      await dependencies.client.publish(
        executionEvent(dependencies.identity, request, item, 'unknown', now, reason),
      );
      return { status: 'unknown', reason };
    }
  }
  await dependencies.client.publish(
    executionEvent(
      dependencies.identity,
      request,
      item,
      'succeeded',
      dependencies.now?.() ?? Math.floor(Date.now() / 1_000),
      request.value.scope.roomId,
    ),
  );
  await dependencies.outbox.remove(item.action.actionId);
  return { status: 'succeeded', roomId: request.value.scope.roomId, reconciled: false };
}

export type PermissionCardProjection = {
  request: ParsedPermissionRequest;
  state: ReturnType<typeof foldPermissionLedger>;
};

/** Projection model consumed by the approval card UI; unknown versions vanish. */
export function projectPermissionCards(
  events: readonly NostrEvent[],
  now: number,
  decisionAuthorized: (event: NostrEvent) => boolean = () => false,
  executionAuthorized: (event: NostrEvent) => boolean = () => false,
): PermissionCardProjection[] {
  return events.flatMap((event) => {
    const request = parsePermissionRequest(event);
    if (!request) return [];
    const related = events.filter((candidate) =>
      candidate.tags.some(
        (tag) => tag[0] === 'permission' && tag[1] === request.value.permissionId,
      ),
    );
    const decisions = related.flatMap((candidate) => {
      const parsed = parsePermissionDecision(candidate, request);
      return parsed ? [parsed] : [];
    });
    const revocations = related.flatMap((candidate) => {
      const parsed = parsePermissionRevocation(candidate, request);
      return parsed ? [parsed] : [];
    });
    const executions = related.flatMap((candidate) => {
      const parsed = parsePermissionExecution(candidate, request);
      return parsed && executionAuthorized(parsed.event) ? [parsed] : [];
    });
    return [
      {
        request,
        state: foldPermissionLedger({
          request,
          decisions,
          revocations,
          executions,
          now,
          decisionAuthorized: (decision) => decisionAuthorized(decision.event),
          revocationAuthorized: (revocation) => decisionAuthorized(revocation.event),
        }),
      },
    ];
  });
}

/** Paired-owner-signed replaceable access settings publication. */
export async function publishAgentAccessSettings(input: {
  identity: Identity;
  client: PermissionEventPublisher;
  workspaceId: string;
  agentPubkey: string;
  policy: AgentAccessPolicyV1;
  allowlist?: string[];
  revision: number;
  updatedAt?: number;
}): Promise<NostrEvent> {
  if (!HEX_64.test(input.agentPubkey)) throw new Error('invalid agent pubkey');
  const event = buildAgentAccessConfig(input.identity, {
    version: 1,
    workspaceId: input.workspaceId,
    agentPubkey: input.agentPubkey,
    policy: input.policy,
    ...(input.policy === 'allowlist' ? { allowlist: input.allowlist ?? [] } : {}),
    revision: input.revision,
    updatedAt: input.updatedAt ?? Math.floor(Date.now() / 1_000),
  });
  await input.client.publish(event);
  return event;
}
