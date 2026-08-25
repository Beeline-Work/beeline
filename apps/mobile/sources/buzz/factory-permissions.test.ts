import { describe, expect, it, vi } from 'vitest';
import {
  buildPermissionExecution,
  buildPermissionRequest,
  createIdentity,
  parseAgentAccessConfig,
  parsePermissionDecision,
  parsePermissionExecution,
  parsePermissionRequest,
  type PermissionFreshReader,
} from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import {
  RoomCreateOutbox,
  executeQueuedRoomCreate,
  grantAndQueueRoomCreate,
  projectPermissionCards,
  publishAgentAccessSettings,
  type ExactRoomState,
  type FactoryOutboxStorage,
  type RoomCreateClient,
} from './factory-permissions';

const ROOT = 'ab'.repeat(32);
const TURN = 'cd'.repeat(32);

class MemoryStorage implements FactoryOutboxStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

function fixture() {
  const agent = createIdentity();
  const owner = createIdentity();
  const otherAdmin = createIdentity();
  const scout = createIdentity();
  const request = buildPermissionRequest(agent, {
    version: 1,
    permissionId: '018f4d8e-7a01-7cc2-91f1-111111111111',
    roomId: 'factory-room',
    workspaceId: 'factory-workspace',
    requesterAgentPubkey: agent.publicKey,
    audience: 'admin',
    summary: 'Create the Launch Room with Scout.',
    scope: {
      type: 'room.create',
      workspaceId: 'factory-workspace',
      roomId: '018f4d8e-7a01-7cc2-91f1-222222222222',
      name: 'Launch Room',
      visibility: 'invite-only',
      participantPubkeys: [owner.publicKey],
      agentPubkeys: [scout.publicKey],
    },
    provenance: { immediateTurnEventId: TURN, rootEventId: ROOT },
    requestedAt: 1_000,
    requestExpiresAt: 2_000,
  }, [owner.publicKey, otherAdmin.publicKey]);
  return { agent, owner, otherAdmin, scout, request };
}

function readerFor(input: {
  request: NostrEvent;
  history: NostrEvent[];
  agentPubkey: string;
}): PermissionFreshReader {
  return {
    readEvent: async (id) => [input.request, ...input.history].find((event) => event.id === id),
    isRegisteredAgent: async (pubkey) => pubkey === input.agentPubkey,
    isRoomMember: async () => true,
    isWorkspaceMember: async () => true,
    roleForRoom: async () => 'owner',
    hasDeviceCustody: async () => true,
    permissionHistory: async () => [...input.history],
  };
}

function roomClient(input: {
  history: NostrEvent[];
  state: { value: ExactRoomState };
  failFirstSuccessReceipt?: boolean;
}) {
  let failSuccess = input.failFirstSuccessReceipt ?? false;
  const createChannel = vi.fn(async (_name: string, options: { channelId: string }) => {
    if (input.state.value !== 'missing') throw new Error('Room already exists');
    input.state.value = 'exact';
    return options.channelId;
  });
  const client: RoomCreateClient = {
    publish: async (event) => {
      const request = fixture().request;
      // Parsing against a different signed request is intentionally avoided;
      // the status tag is canonical and was built by the shared builder.
      const status = event.tags.find((tag) => tag[0] === 'status')?.[1];
      if (status === 'succeeded' && failSuccess) {
        failSuccess = false;
        throw new Error('relay unavailable after Room create');
      }
      void request;
      input.history.push(event);
    },
    createChannel,
    setMemberRole: async () => undefined,
    attachAgentToChannel: async () => undefined,
  };
  return { client, createChannel };
}

describe('factory permission mobile runtime', () => {
  it('uses a standing envelope by default and projects the grant card', async () => {
    const { owner, request } = fixture();
    const history: NostrEvent[] = [];
    const outbox = new RoomCreateOutbox(new MemoryStorage());
    const item = await grantAndQueueRoomCreate({
      identity: owner,
      requestEvent: request,
      client: { publish: async (event) => history.push(event) },
      outbox,
      now: 1_001,
    });
    expect(JSON.parse(item.decision.content).grant).toMatchObject({
      tier: 1,
      mode: 'standing',
      maxUses: 1,
    });
    expect(item.action.roomId).toBe('factory-room');
    expect(item.action.scope).toMatchObject({
      type: 'room.create',
      roomId: '018f4d8e-7a01-7cc2-91f1-222222222222',
    });
    expect(projectPermissionCards([request, ...history], 1_002, () => true)[0]?.state.status).toBe('granted');
    expect(await outbox.get(item.action.actionId)).toEqual(item);
  });

  it('ignores execution receipts outside the trusted executor authority', async () => {
    const { owner, otherAdmin, request } = fixture();
    const history: NostrEvent[] = [];
    const item = await grantAndQueueRoomCreate({
      identity: owner,
      requestEvent: request,
      client: { publish: async (event) => history.push(event) },
      outbox: new RoomCreateOutbox(new MemoryStorage()),
      now: 1_001,
    });
    const parsedRequest = parsePermissionRequest(request)!;
    const decision = parsePermissionDecision(item.decision, parsedRequest)!;
    const receiptValue = {
      version: 1 as const,
      permissionId: item.action.permissionId,
      grantEventId: decision.event.id,
      actionId: item.action.actionId,
      idempotencyKey: item.action.idempotencyKey,
      attempt: 1,
      at: 1_002,
    };
    const started = buildPermissionExecution(owner, parsedRequest, {
      ...receiptValue,
      status: 'started',
      charge: item.action.charge,
    });
    const forgedUnknown = buildPermissionExecution(otherAdmin, parsedRequest, {
      ...receiptValue,
      status: 'unknown',
      result: 'forged',
    });
    expect(projectPermissionCards(
      [request, item.decision, started, forgedUnknown],
      1_003,
      () => true,
      (event) => event.pubkey === owner.publicKey,
    )[0]?.state.status).toBe('executing');
  });

  it('resumes after Room creation and before receipt without creating twice', async () => {
    const { agent, owner, request } = fixture();
    const history: NostrEvent[] = [];
    const storage = new MemoryStorage();
    const outbox = new RoomCreateOutbox(storage);
    const item = await grantAndQueueRoomCreate({
      identity: owner,
      requestEvent: request,
      client: { publish: async (event) => history.push(event) },
      outbox,
      now: 1_001,
    });
    const state: { value: ExactRoomState } = { value: 'missing' };
    const { client, createChannel } = roomClient({
      history,
      state,
      failFirstSuccessReceipt: true,
    });
    const dependencies = {
      identity: owner,
      reader: readerFor({ request, history, agentPubkey: agent.publicKey }),
      client,
      outbox,
      inspectRoomFresh: async () => state.value,
      now: () => 1_002,
    };
    await expect(executeQueuedRoomCreate(dependencies, item)).rejects.toThrow('relay unavailable');
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(await outbox.get(item.action.actionId)).toBeDefined();
    await expect(executeQueuedRoomCreate(dependencies, item)).resolves.toMatchObject({
      status: 'succeeded',
      reconciled: true,
    });
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(await outbox.get(item.action.actionId)).toBeUndefined();
  });

  it('lets only the first valid admin decision create the deterministic Room', async () => {
    const { agent, owner, otherAdmin, request } = fixture();
    const history: NostrEvent[] = [];
    const outboxA = new RoomCreateOutbox(new MemoryStorage());
    const outboxB = new RoomCreateOutbox(new MemoryStorage());
    const itemA = await grantAndQueueRoomCreate({
      identity: owner,
      requestEvent: request,
      client: { publish: async (event) => history.push(event) },
      outbox: outboxA,
      now: 1_001,
    });
    const itemB = await grantAndQueueRoomCreate({
      identity: otherAdmin,
      requestEvent: request,
      client: { publish: async (event) => history.push(event) },
      outbox: outboxB,
      now: 1_001,
    });
    const [winner, loser] = itemA.decision.id < itemB.decision.id
      ? [[itemA, owner, outboxA] as const, [itemB, otherAdmin, outboxB] as const]
      : [[itemB, otherAdmin, outboxB] as const, [itemA, owner, outboxA] as const];
    const state: { value: ExactRoomState } = { value: 'missing' };
    const shared = roomClient({ history, state });
    const run = ([item, identity, outbox]: typeof winner) => executeQueuedRoomCreate({
      identity,
      reader: readerFor({ request, history, agentPubkey: agent.publicKey }),
      client: shared.client,
      outbox,
      inspectRoomFresh: async () => state.value,
      now: () => 1_002,
    }, item);
    const [won, lost] = await Promise.all([run(winner), run(loser)]);
    expect(won.status).toBe('succeeded');
    expect(lost).toMatchObject({ status: 'refused', reason: 'decision-not-winning' });
    expect(shared.createChannel).toHaveBeenCalledTimes(1);
  });

  it('publishes paired-owner signed allowlist settings', async () => {
    const { owner, agent } = fixture();
    const published: NostrEvent[] = [];
    const event = await publishAgentAccessSettings({
      identity: owner,
      client: { publish: async (value) => published.push(value) },
      workspaceId: 'factory-workspace',
      agentPubkey: agent.publicKey,
      policy: 'allowlist',
      allowlist: [owner.publicKey],
      revision: 3,
      updatedAt: 1_100,
    });
    expect(published).toEqual([event]);
    expect(parseAgentAccessConfig(event)).toMatchObject({
      policy: 'allowlist',
      allowlist: [owner.publicKey],
      revision: 3,
    });
  });

  it('keeps malformed unknown-version permission events out of cards', () => {
    const { request } = fixture();
    const malformed = { ...request, content: request.content.replace('"version":1', '"version":2') };
    expect(projectPermissionCards([malformed], 1_001)).toEqual([]);
    expect(parsePermissionExecution(malformed, parsePermissionRequestSafe(request))).toBeUndefined();
  });
});

function parsePermissionRequestSafe(event: NostrEvent) {
  const parsed = projectPermissionCards([event], 1_001)[0]?.request;
  if (!parsed) throw new Error('fixture request did not parse');
  return parsed;
}
