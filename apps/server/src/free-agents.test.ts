import { createECDH } from 'node:crypto';
import { getPublicKey } from '@beeline/nostr';
import { AGENT_MENTION_NOTICE_GRACE_MS } from '@beeline/api-contract/agent-access';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import {
  claimAgentConnection,
  releaseAgentConnection,
  releaseStaleServerConnections,
} from './connection-presence.js';
import { migrate } from './database.js';
import type { FreeAgentMachines, FreeAgentMachineSpec } from './fly-machines.js';
import {
  addFreeAgentToWorkspace,
  FREE_AGENT_EXIT_NOTE,
  FREE_AGENT_JOIN_GREETING,
  FreeAgentService,
  generateAgentKeypair,
  openSecrets,
  type FreeAgentConfig,
} from './free-agents.js';
import { LiveHub } from './live.js';
import { agentMachineOfflineSql } from './machine-offline.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const ORDINARY = 'c'.repeat(64);

const TEST_FREE_AGENT_CONFIG: FreeAgentConfig = {
  model: 'deepseek/deepseek-v4-flash',
  idleSeconds: 60,
  maxPerOwner: 3,
  dailyTokenCap: 300_000,
  lifetimeTokenCap: 3_000_000,
  sealSecret: 'test-seal-secret',
  publicOrigin: 'https://server.test',
  image: 'registry.fly.io/beeline-free-agents:test',
  region: 'iad',
  cpus: 1,
  memoryMb: 1024,
  sleepMode: 'suspend',
  reapIdleMs: 300_000,
  deleteAfterMs: 30 * 86_400_000,
};

/** Fly Machines stand-in: records every call and keeps each Machine's state. */
class FakeMachines implements FreeAgentMachines {
  readonly calls: string[] = [];
  readonly specs: FreeAgentMachineSpec[] = [];
  readonly states = new Map<string, string>();
  failSuspend = false;
  #next = 0;

  async create(spec: FreeAgentMachineSpec) {
    const id = `m${++this.#next}`;
    this.calls.push(`create ${spec.agentId.slice(0, 4)}`);
    this.specs.push(spec);
    this.states.set(id, 'started');
    return { id };
  }
  async find(agentId: string) {
    const index = this.specs.findIndex((spec) => spec.agentId === agentId);
    const id = index >= 0 ? `m${index + 1}` : undefined;
    const state = id ? this.states.get(id) : undefined;
    return id && state && state !== 'destroyed' ? { id, state } : undefined;
  }
  async start(id: string) {
    this.calls.push(`start ${id}`);
    this.states.set(id, 'started');
  }
  async suspend(id: string) {
    this.calls.push(`suspend ${id}`);
    if (this.failSuspend) throw new Error('suspend unavailable');
    this.states.set(id, 'suspended');
  }
  async stop(id: string) {
    this.calls.push(`stop ${id}`);
    this.states.set(id, 'stopped');
  }
  async destroy(id: string) {
    this.calls.push(`destroy ${id}`);
    this.states.set(id, 'destroyed');
  }
  async state(id: string) {
    const state = this.states.get(id);
    return state === 'destroyed' ? undefined : state;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('free starter agents', () => {
  let db: PgliteDatabase;
  let live: LiveHub;
  let machines: FakeMachines;
  let freeAgents: FreeAgentService;
  let phone: PhoneService;
  let exchanges: string[];

  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    live = new LiveHub();
    machines = new FakeMachines();
    exchanges = [];
    freeAgents = new FreeAgentService(
      db,
      TEST_FREE_AGENT_CONFIG,
      machines,
      async (agentId) => {
        const token = `bde_${String(exchanges.length).padStart(43, '0')}`;
        exchanges.push(agentId);
        return { exchangeToken: token };
      },
      () => undefined,
    );
    phone = new PhoneService(db, 'https://server.test', undefined, undefined, live);
    phone.setFreeAgents(freeAgents);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
        ($1,'human','Charles','lunchboxfortwo'),($2,'human','Friend','friend')`,
      [OWNER, FRIEND],
    );
  });
  afterEach(async () => {
    await settle();
    await db.close();
  });

  const createWorkspace = async (name = 'Fresh', viewer = OWNER) =>
    phone.execute('createWorkspace', { name }, viewer) as Promise<{ id: string; roomId: string }>;

  const freeAgentOf = async (workspaceId: string) =>
    (
      await db.query<{ agent_id: string; state: string; fly_machine_id: string | null }>(
        `SELECT agent_id,state,fly_machine_id FROM free_agents WHERE workspace_id=$1`,
        [workspaceId],
      )
    ).rows[0]!;

  it('creates the agent and its provisioning in the same flow as #general, with a pending hello', async () => {
    const { id, roomId } = await createWorkspace();
    const agent = await freeAgentOf(id);
    expect(agent.state).toMatch(/provisioning|waking/);

    const identity = (
      await db.query<{ kind: string; handle: string | null; owner_id: string; selected_model: string }>(
        `SELECT i.kind,i.handle,a.owner_id,a.selected_model FROM identities i
         JOIN agents a ON a.agent_id=i.id WHERE i.id=$1`,
        [agent.agent_id],
      )
    ).rows[0]!;
    expect(identity).toMatchObject({
      kind: 'agent',
      owner_id: OWNER,
      selected_model: 'beeline/deepseek/deepseek-v4-flash',
    });
    expect(identity.handle).toBeTruthy();
    // A member of the Workspace and of #general, created in the same transaction.
    expect(
      (
        await db.query(
          `SELECT room_id FROM memberships WHERE identity_id=$1 AND removed_at IS NULL ORDER BY room_id NULLS FIRST`,
          [agent.agent_id],
        )
      ).rows,
    ).toEqual([{ room_id: null }, { room_id: roomId }]);
    // The hello is a pending wake in #general, sourced from its own joined line.
    const hello = (
      await db.query<{ state: string; room_id: string; private_payload: unknown; text: string }>(
        `SELECT command.state,command.room_id,command.private_payload,source.text FROM agent_commands command
         JOIN messages source ON source.id=command.source_message_id
         WHERE command.agent_id=$1 AND command.reason='free_agent_hello'`,
        [agent.agent_id],
      )
    ).rows;
    expect(hello).toHaveLength(1);
    // A public wake on its own joined line: its reply is a Room message, not a report.
    expect(hello[0]).toMatchObject({ state: 'pending', room_id: roomId, private_payload: null });
    expect(hello[0]!.text).toMatch(/joined · invited by @lunchboxfortwo/);
    // Reachable before its Machine ever booted.
    const presence = (
      await db.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
        [agent.agent_id],
      )
    ).rows[0]!.body;
    expect(presence).toMatchObject({ status: 'online', held: true, asleep: true });

    // The committed create provisions its Machine with no further user action.
    await settle();
    expect(machines.calls).toEqual([`create ${agent.agent_id.slice(0, 4)}`]);
    const spec = machines.specs[0]!;
    expect(spec.env.BEELINE_FREE_AGENT_ID).toBe(agent.agent_id);
    expect(spec.env.BEELINE_FREE_AGENT_BOOTSTRAP).toMatch(/^bfb_/);
    expect(spec.env.BEELINE_SERVER_URL).toBe('https://server.test');
    expect(spec).toMatchObject({ cpus: 1, memoryMb: 1024, region: 'iad' });
    expect(await freeAgentOf(id)).toMatchObject({ state: 'waking', fly_machine_id: 'm1' });
    expect(
      (
        await db.query(`SELECT kind FROM free_agent_events WHERE agent_id=$1 ORDER BY id`, [
          agent.agent_id,
        ])
      ).rows.map((row) => row.kind),
    ).toEqual(['created', 'provisioned']);
  });

  it('creates no second agent on a retried create, and stops at the per-owner limit', async () => {
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    await phone.execute('createWorkspace', { workspaceId, name: 'Once' }, OWNER);
    await phone.execute('createWorkspace', { workspaceId, name: 'Once' }, OWNER);
    expect(
      (await db.query(`SELECT 1 FROM free_agents WHERE workspace_id=$1`, [workspaceId])).rowCount,
    ).toBe(1);
    await createWorkspace('Two');
    await createWorkspace('Three');
    const { id } = await createWorkspace('Four');
    expect((await db.query(`SELECT 1 FROM free_agents WHERE workspace_id=$1`, [id])).rowCount).toBe(0);
    expect(
      (await db.query(`SELECT 1 FROM free_agents WHERE owner_id=$1`, [OWNER])).rowCount,
    ).toBe(3);
  });

  it('seals keys that derive the agent identity, and bootstraps the Machine once per grant', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const sealed = (
      await db.query<{ sealed_keys: string }>(`SELECT sealed_keys FROM free_agents WHERE agent_id=$1`, [
        agent.agent_id,
      ])
    ).rows[0]!.sealed_keys;
    expect(sealed).not.toContain(agent.agent_id);
    const keys = openSecrets<{ agent: string; body: string }>('test-seal-secret', sealed);
    expect(getPublicKey(Buffer.from(keys.agent, 'hex'))).toBe(agent.agent_id);

    expect(await freeAgents.bootstrap('bfb_wrong')).toBeUndefined();
    const token = machines.specs[0]!.env.BEELINE_FREE_AGENT_BOOTSTRAP!;
    const grant = (await freeAgents.bootstrap(token))!;
    expect(grant).toMatchObject({
      agentId: agent.agent_id,
      agentSecretKey: keys.agent,
      harness: 'opencode',
      model: 'beeline/deepseek/deepseek-v4-flash',
      upstreamModel: 'deepseek/deepseek-v4-flash',
      workspaceId: id,
      pairedBy: OWNER,
      monolithBaseUrl: 'https://server.test',
      modelBaseUrl: 'https://server.test/v1/free-agents/model',
      idleSeconds: 60,
    });
    expect(grant.modelToken).toMatch(/^bfm_/);
    expect(exchanges).toEqual([agent.agent_id]);
    // A retried first boot gets a fresh exchange and model token; the old model token dies.
    const retry = (await freeAgents.bootstrap(token))!;
    expect(retry.modelToken).not.toBe(grant.modelToken);
    expect(exchanges).toHaveLength(2);
  });

  it('keeps a free agent reachable and its wake alive while its Machine is offline, and starts the Machine', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    // An ordinary agent on a machine with no live helper, in the same Room.
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Ordinary','ordinary')`, [
      ORDINARY,
    ]);
    await db.query(
      `INSERT INTO agents(agent_id,owner_id,machine_id,machine_name) VALUES($1,$2,'laptop','Laptop')`,
      [ORDINARY, OWNER],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [id, ORDINARY, roomId],
    );
    // Both helpers connected once and went away; the free agent's Machine is asleep.
    await db.query(
      `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('server-1',now())
       ON CONFLICT DO NOTHING`,
    );
    for (const agentId of [agent.agent_id, ORDINARY]) {
      await claimAgentConnection(db, live, agentId, { lifecycleId: `life-${agentId}` }, {
        connectionId: `conn-${agentId}`,
        instanceId: 'server-1',
      });
      await releaseAgentConnection(db, live, agentId, `conn-${agentId}`);
    }
    await db.query(`UPDATE free_agents SET state='sleeping' WHERE agent_id=$1`, [agent.agent_id]);
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE agent_id=$1`, [
      agent.agent_id,
    ]);

    const offline = async (agentId: string) =>
      (
        await db.query<{ offline: boolean }>(`SELECT ${agentMachineOfflineSql('$1')} offline`, [agentId])
      ).rows[0]!.offline;
    expect(await offline(agent.agent_id)).toBe(false);
    expect(await offline(ORDINARY)).toBe(true);

    const presence = async (agentId: string) =>
      (
        await db.query<{ body: Record<string, unknown> }>(
          `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
          [agentId],
        )
      ).rows[0]!.body;
    expect(await presence(agent.agent_id)).toMatchObject({ status: 'online', held: true, asleep: true });
    expect(await presence(ORDINARY)).toMatchObject({ status: 'offline', held: false });

    // The owner tags both agents. The free agent's wake is kept and starts its
    // Machine; the ordinary agent is told offline after the grace window.
    const handle = (
      await db.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [agent.agent_id])
    ).rows[0]!.handle;
    machines.calls.length = 0;
    await phone.execute(
      'sendRoomMessage',
      {
        roomId,
        messageId: '9'.repeat(64),
        text: `@${handle} @ordinary make a file`,
        mentions: [agent.agent_id, ORDINARY],
      },
      OWNER,
    );
    const pending = (
      await db.query<{ agent_id: string; state: string }>(
        `SELECT agent_id,state FROM agent_commands WHERE source_message_id=$1 ORDER BY agent_id`,
        ['9'.repeat(64)],
      )
    ).rows;
    expect(pending).toEqual(
      expect.arrayContaining([{ agent_id: agent.agent_id, state: 'pending' }]),
    );
    freeAgents.kickIfFree(ORDINARY);
    freeAgents.kickIfFree(agent.agent_id);
    await settle();
    expect(machines.calls).toEqual(['start m1']);
    expect(await freeAgentOf(id)).toMatchObject({ state: 'waking' });
    await phone.flushPendingMentionNotices(Date.now() + AGENT_MENTION_NOTICE_GRACE_MS + 1_000);
    const notices = (
      await db.query<{ author_id: string; text: string }>(
        `SELECT author_id,text FROM messages WHERE room_id=$1 AND text LIKE '%did not answer%'`,
        [roomId],
      )
    ).rows;
    expect(notices).toEqual([{ author_id: ORDINARY, text: '@ordinary did not answer @lunchboxfortwo · its helper is offline' }]);

    // The Machine's helper registers: the free agent is running again.
    await claimAgentConnection(db, live, agent.agent_id, { lifecycleId: 'life-2' }, {
      connectionId: 'conn-2',
      instanceId: 'server-1',
    });
    expect(await freeAgentOf(id)).toMatchObject({ state: 'running' });
    expect(
      (
        await db.query(`SELECT kind,detail FROM free_agent_events WHERE agent_id=$1 AND kind IN ('wake_requested','machine_started','connected') ORDER BY id`, [
          agent.agent_id,
        ])
      ).rows.map((row) => row.kind),
    ).toEqual(['connected', 'wake_requested', 'machine_started', 'connected']);
  });

  it('keeps a free agent reachable when its server instance dies, unlike an ordinary agent', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await db.query(
      `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('dead',now()-interval '1 hour')`,
    );
    await claimAgentConnection(db, live, agent.agent_id, { lifecycleId: 'life' }, {
      connectionId: 'conn',
      instanceId: 'dead',
    });
    expect(await releaseStaleServerConnections(db, 90_000)).toEqual([agent.agent_id]);
    expect(
      (
        await db.query<{ body: Record<string, unknown> }>(
          `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
          [agent.agent_id],
        )
      ).rows[0]!.body,
    ).toMatchObject({ status: 'online', held: true, asleep: true });
  });

  it('sleeps only when no wake is pending, suspending and falling back to stop', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    // The hello is still pending: no sleep.
    expect(await freeAgents.requestSleep(agent.agent_id)).toEqual({ sleep: false });
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    await db.query(`UPDATE free_agents SET state='running' WHERE agent_id=$1`, [agent.agent_id]);
    machines.calls.length = 0;
    expect(await freeAgents.requestSleep(agent.agent_id)).toEqual({ sleep: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(machines.calls).toEqual(['suspend m1']);
    expect(await freeAgentOf(id)).toMatchObject({ state: 'sleeping' });
    // Asleep is not a second sleep.
    expect(await freeAgents.requestSleep(agent.agent_id)).toEqual({ sleep: false });

    await db.query(`UPDATE free_agents SET state='running' WHERE agent_id=$1`, [agent.agent_id]);
    machines.failSuspend = true;
    machines.calls.length = 0;
    expect(await freeAgents.requestSleep(agent.agent_id)).toEqual({ sleep: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(machines.calls).toEqual(['suspend m1', 'stop m1']);
    expect(roomId).toBeTruthy();
  });

  it('sweeps: retries provisioning, wakes an overdue wake, reaps an idle Machine, deletes after 30 days and recreates on wake', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now()-interval '1 hour' WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    // A running Machine with no work for longer than the reap window.
    await db.query(
      `UPDATE free_agents SET state='running',last_activity_at=now()-interval '10 minutes',
         wake_requested_at=now()-interval '10 minutes' WHERE agent_id=$1`,
      [agent.agent_id],
    );
    machines.calls.length = 0;
    await freeAgents.sweep();
    expect(machines.calls).toEqual(['stop m1']);
    expect(await freeAgentOf(id)).toMatchObject({ state: 'sleeping' });

    // Thirty days with no activity: the Machine is deleted.
    await db.query(`UPDATE free_agents SET last_activity_at=now()-interval '31 days' WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    await db.query(`UPDATE agent_commands SET created_at=now()-interval '31 days' WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    machines.calls.length = 0;
    await freeAgents.sweep();
    expect(machines.calls).toEqual(['destroy m1']);
    expect(await freeAgentOf(id)).toMatchObject({ state: 'destroyed', fly_machine_id: null });

    // A later wake recreates the Machine (the agent and its identity are kept).
    const source = 'f'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'are you there?')`, [
      source,
      roomId,
      OWNER,
    ]);
    await createAgentCommand(db, {
      roomId,
      agentId: agent.agent_id,
      sourceMessageId: source,
      reason: 'human_tag',
      id: 'e'.repeat(64),
    });
    await db.query(`UPDATE agent_commands SET created_at=now()-interval '1 minute' WHERE id=$1`, [
      'e'.repeat(64),
    ]);
    machines.calls.length = 0;
    await freeAgents.sweep();
    expect(machines.calls).toEqual([`create ${agent.agent_id.slice(0, 4)}`]);
    expect(await freeAgentOf(id)).toMatchObject({ state: 'waking', fly_machine_id: 'm2' });
  });

  it('adds one free agent to an existing Workspace in its #general, owned by its owner', async () => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Old')`, [workspaceId]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [workspaceId, OWNER, FRIEND],
    );
    const lounge = '55555555-5555-4555-8555-555555555555';
    const general = '66666666-6666-4666-8666-666666666666';
    await db.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,created_at) VALUES
        ($1,$3,$4,'lounge','public',now()-interval '2 days'),($2,$3,$4,'general','public',now()-interval '1 day')`,
      [lounge, general, workspaceId, OWNER],
    );
    const agentId = await addFreeAgentToWorkspace(db, freeAgents, workspaceId);
    expect(agentId).toBeTruthy();
    expect(machines.calls).toEqual([`create ${agentId!.slice(0, 4)}`]);
    expect(
      (await db.query(`SELECT owner_id FROM free_agents WHERE agent_id=$1`, [agentId])).rows,
    ).toEqual([{ owner_id: OWNER }]);
    expect(
      (
        await db.query(`SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL`, [agentId])
      ).rows,
    ).toEqual([{ room_id: general }]);
    expect(await addFreeAgentToWorkspace(db, freeAgents, workspaceId)).toBeUndefined();
  });

  it('hears #general joins and leaves from creation', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    expect(
      (
        await db.query(`SELECT event_subscriptions FROM memberships WHERE identity_id=$1 AND room_id=$2`, [
          agent.agent_id,
          roomId,
        ])
      ).rows,
    ).toEqual([{ event_subscriptions: ['joined', 'left'] }]);
    const wakes = async () =>
      (
        await db.query<{ text: string }>(
          `SELECT source.text FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
           WHERE command.agent_id=$1 AND command.reason='subscribed_event' ORDER BY command.created_at`,
          [agent.agent_id],
        )
      ).rows.map((row) => row.text);

    // A person joins the Workspace: one joined event in #general wakes the free agent.
    await phone.execute('addWorkspaceMember', { workspaceId: id, memberId: FRIEND, role: 'member' }, OWNER);
    expect(await wakes()).toEqual(['@friend joined · invited by @lunchboxfortwo']);

    // The person leaves #general, then the Workspace: each departure is one left event.
    await phone.execute('leaveRoom', { roomId }, FRIEND);
    expect((await wakes()).at(-1)).toBe('@friend left');
    await phone.execute('addRoomMember', { roomId, memberIds: [FRIEND] }, OWNER);
    await phone.execute('leaveWorkspace', { workspaceId: id }, FRIEND);
    expect((await wakes()).at(-1)).toBe('@friend left');
    expect(
      (
        await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='member-left'`, [roomId])
      ).rowCount,
    ).toBe(2);
  });

  it('carries the owner\'s exact join greeting and the exit note in the free agent\'s instructions', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const soul = (
      await db.query<{ soul: { instructions: string } }>(`SELECT soul FROM agents WHERE agent_id=$1`, [
        agent.agent_id,
      ])
    ).rows[0]!.soul.instructions;
    expect(FREE_AGENT_JOIN_GREETING).toBe(
      "what up boss? I'm a pro bono agent for beeline. I can help you set up this workspace, invite other humans and agents, or whatever else you might need",
    );
    expect(soul).toContain(FREE_AGENT_JOIN_GREETING);
    expect(soul).toContain(FREE_AGENT_EXIT_NOTE);
    expect(soul).toContain('Never greet an agent.');
  });

  it('generates keys in the helper identity format', () => {
    const pair = generateAgentKeypair();
    expect(pair.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(Buffer.from(pair.secretKey, 'hex'))).toBe(pair.publicKey);
    expect(createECDH('secp256k1')).toBeTruthy();
  });
});
