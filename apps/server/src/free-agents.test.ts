import { postRepositoryOnboarding } from './repository-onboarding.js';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { createECDH } from 'node:crypto';
import { getPublicKey } from '@beeline/nostr';
import { AGENT_MENTION_NOTICE_GRACE_MS } from '@beeline/api-contract/agent-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
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
  FREE_AGENT_TURN_GUIDE,
  FREE_AGENT_HELLO,
  FREE_AGENT_JOIN_GREETING,
  FreeAgentService,
  generateAgentKeypair,
  openSecrets,
  freeAgentConfigFromEnv,
  type FreeAgentConfig,
} from './free-agents.js';
import { PushDeliveryLoop } from './background.js';
import { resolveCurrentMemberMentions } from './message-mentions.js';
import { LiveHub } from './live.js';
import { agentMachineOfflineSql } from './machine-offline.js';
import { PhoneService } from './phone-service.js';
import type { GitHubOperations } from './github-operations.js';
import { PgliteDatabase } from './test-support.js';

const sentryCaptures = vi.hoisted(() => [] as { error: unknown; tags: Record<string, string> | undefined }[]);
vi.mock('./sentry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentry.js')>()),
  captureServerError: (error: unknown, tags?: Record<string, string>) => {
    sentryCaptures.push({ error, tags });
  },
}));

const OWNER = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const ORDINARY = 'c'.repeat(64);

const TEST_FREE_AGENT_CONFIG: FreeAgentConfig = {
  model: 'deepseek/deepseek-v4-flash',
  idleSeconds: 60,
  maxPerOwner: 3,
  dailyTokenCap: 1_000_000,
  lifetimeTokenCap: 3_000_000,
  sealSecret: 'test-seal-secret',
  publicOrigin: 'https://server.test',
  image: 'registry.fly.io/beeline-free-agents:test',
  region: 'iad',
  cpus: 1,
  memoryMb: 1024,
  reapIdleMs: 300_000,
  deleteAfterMs: 30 * 86_400_000,
};

/** Fly Machines stand-in: records every call and keeps each Machine's state. */
class FakeMachines implements FreeAgentMachines {
  readonly calls: string[] = [];
  readonly specs: FreeAgentMachineSpec[] = [];
  readonly states = new Map<string, string>();
  failSuspend = false;
  failDestroy = false;
  beforeCreate?: () => Promise<void>;
  beforeDestroy?: () => Promise<void>;
  #next = 0;

  async create(spec: FreeAgentMachineSpec) {
    await this.beforeCreate?.();
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
    await this.beforeDestroy?.();
    this.calls.push(`destroy ${id}`);
    if (this.failDestroy) throw new Error('delete unavailable');
    this.states.set(id, 'destroyed');
  }
  async state(id: string) {
    const state = this.states.get(id);
    return state === 'destroyed' ? undefined : state;
  }
  async waitFor() {}
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
    sentryCaptures.length = 0;
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
    vi.unstubAllEnvs();
    await settle();
    await db.close();
  });

  // Lifecycle tests start after the owner's first actual request, not the server hello.
  const createWorkspace = async (name = 'Fresh', viewer = OWNER) => {
    const result = await phone.execute('createWorkspace', { name }, viewer) as { id: string; roomId: string };
    const agent = (await db.query<{ agent_id: string }>(`SELECT agent_id FROM free_agents WHERE workspace_id=$1`, [result.id])).rows[0];
    if (agent) {
      await createAgentCommand(db, { roomId: result.roomId, agentId: agent.agent_id, sourceMessageId: null, reason: 'human_tag' });
      await freeAgents.provision(agent.agent_id);
    }
    return result;
  };

  const freeAgentOf = async (workspaceId: string) =>
    (
      await db.query<{ agent_id: string; state: string; fly_machine_id: string | null }>(
        `SELECT agent_id,state,fly_machine_id FROM free_agents WHERE workspace_id=$1`,
        [workspaceId],
      )
    ).rows[0]!;

  it('adds the repository guide to a Google-only runtime without feature configuration', async () => {
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Always on' }, OWNER) as { id:string;roomId:string };
    const agent = await freeAgentOf(id);
    const daemon = new DaemonService(db, live);
    await db.query(`UPDATE agents SET soul=jsonb_set(soul,'{instructions}','"Original soul"'::jsonb)
      WHERE agent_id=$1`, [agent.agent_id]);
    const configuration = await daemon.execute('getAgentConfiguration', { roomId }, agent.agent_id);
    expect(configuration.soul?.instructions).toContain('beeline:onboarding');
    expect(configuration.soul?.instructions).toContain(FREE_AGENT_TURN_GUIDE);
    const stored=(await db.query<{soul:{instructions:string}}>(`SELECT soul FROM agents WHERE agent_id=$1`,[agent.agent_id])).rows[0]!;
    expect(stored.soul.instructions).not.toContain('beeline:onboarding');
  });

  it('onboarding-invite-1: an unlinked Room join does not presume coding intent', async () => {
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Existing unlinked workspace' }, OWNER) as { id: string; roomId: string };
    const agent = await freeAgentOf(id);
    const invite = await phone.execute('createInvite', { workspaceId: id }, OWNER);
    await phone.execute('redeemInvite', { token: invite.token }, FRIEND);
    expect((await phone.readRoom(roomId, FRIEND))?.messages.some(message => message.onboarding)).toBe(false);
    expect((await freeAgentOf(id)).agent_id).toBe(agent.agent_id);
  });

  it('onboarding-invite-1: an eligible invitee selects a starter from an existing Beebee without repository-management rights', async () => {
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Existing workspace' }, OWNER) as { id: string; roomId: string };
    const agent = await freeAgentOf(id);
    await db.query(`UPDATE rooms SET repository_name='tester/existing',repository_key='github:42',
      repository_remote='git://github.com/tester/existing',repository_resolution='repository' WHERE id=$1`, [roomId]);
    const github = { onboardingSignals: vi.fn(async () => ({ commits: [], failingChecks: [], issues: [], branches: [], files: [] })) } as unknown as GitHubOperations;
    phone = new PhoneService(db, 'https://server.test', github, undefined, live);
    await db.query(`UPDATE identities SET github_subject='296966200' WHERE id=$1`, [FRIEND]);
    const invite = await phone.execute('createInvite', { workspaceId: id }, OWNER);
    await phone.execute('redeemInvite', { token: invite.token }, FRIEND);
    expect((await phone.readRoom(roomId, FRIEND))?.messages.some(message => message.onboarding)).toBe(false);
    // A subsequent coding request can still offer the existing repository's starters.
    await postRepositoryOnboarding(db, github, { roomId, agentId: agent.agent_id, requesterId: FRIEND, kind: 'starters' });
    const joined = await phone.readRoom(roomId, FRIEND);
    const card = joined?.messages.find(message => message.onboarding?.requesterId === FRIEND)?.onboarding;
    expect(card).toMatchObject({ kind: 'starters', requesterId: FRIEND, repository: 'tester/existing', canLink: false });
    expect(card?.starters).toHaveLength(3);
    expect((await phone.readRoom(roomId, OWNER))?.messages.some(message => message.onboarding)).toBe(false);
    await expect(phone.execute('actOnRepositoryCard', { roomId, cardId: card!.id, action: 'link', repositoryId: 42 }, FRIEND)).rejects.toThrow();
    await phone.execute('actOnRepositoryCard', { roomId, cardId: card!.id, action: 'starter', starterId: 'readme' }, FRIEND);
    const command = (await db.query<{ id: string; turn_request_id: string }>(
      `SELECT c.id,c.turn_request_id FROM agent_commands c JOIN messages m ON m.id=c.root_source_message_id
       WHERE c.agent_id=$1 AND c.room_id=$2 AND m.author_id=$3 AND m.text LIKE '%Make the README useful%'`, [agent.agent_id, roomId, FRIEND])).rows[0]!;
    expect(command).toBeDefined();
    await claimAgentCommand(db, roomId, agent.agent_id, command.id, 'invite-generation');
    const daemon = new DaemonService(db, live);
    const context = { roomId, requestId: command.turn_request_id, generationId: 'invite-generation' };
    const configuration = await daemon.execute('getAgentConfiguration', context as never, agent.agent_id);
    expect(configuration.soul?.instructions).toContain('beeline:onboarding');
    expect(configuration.soul?.instructions).toContain(FREE_AGENT_TURN_GUIDE);
    expect(await daemon.execute('getRoomRepositoryState', context as never, agent.agent_id)).toMatchObject({ repositoryOnboarding: true });
    expect(await daemon.execute('postRepositoryOnboarding', { ...context, kind: 'repository' } as never, agent.agent_id))
      .toMatchObject({ requesterId: FRIEND, canLink: false });
    const ownerMessageId = 'd'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Help with this project')`, [ownerMessageId, roomId, OWNER]);
    const ownerCommand = (await createAgentCommand(db, { roomId, agentId: agent.agent_id,
      sourceMessageId: ownerMessageId, reason: 'human_tag', turnRequestId: 'owner-request' }))!;
    await claimAgentCommand(db, roomId, agent.agent_id, ownerCommand.id, 'owner-generation');
    const ownerContext = { roomId, requestId: ownerCommand.turn_request_id, generationId: 'owner-generation' };
    expect((await daemon.execute('getAgentConfiguration', ownerContext as never, agent.agent_id)).soul?.instructions).toContain('beeline:onboarding');
    expect(await daemon.execute('getRoomRepositoryState', ownerContext as never, agent.agent_id)).toHaveProperty('repositoryOnboarding', true);
    expect(await daemon.execute('postRepositoryOnboarding', { ...ownerContext, kind: 'repository' } as never, agent.agent_id)).toMatchObject({ requesterId: OWNER, canLink: true });
    await db.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"settled"')
      WHERE room_id=$1 AND card_type='repository-onboarding' AND card->>'requesterId'=$2`, [roomId, OWNER]);
    const repeated = await Promise.all(Array.from({ length: 3 }, () =>
      new DaemonService(db, live).execute('postRepositoryOnboarding', { ...ownerContext, kind: 'repository' } as never, agent.agent_id)));
    expect(new Set(repeated.map(card => card.id)).size).toBe(1);
    expect((await phone.readRoom(roomId, OWNER))?.messages.filter(message =>
      message.onboarding?.requesterId === OWNER && message.onboarding.status === 'open')).toHaveLength(1);
  });

  it('E1: Google onboarding posts a real handle and hello without a repository card', async () => {
    const auth = new TokenAuth(db, async () => { throw new Error('GitHub is not needed'); },
      () => new Date(), async () => ({ subject: 'google-new-owner', name: 'Alex Chen', email: 'alex.chen@gmail.com', audience: 'google-client' }));
    const google = await auth.exchangeGoogleOidc('verified-fixture-ticket');
    const workspace = await phone.execute('createWorkspace', { name: 'Google onboarding' }, google.identityId);
    const beebee = await freeAgentOf(workspace.id);
    const hello = (await db.query<{ text: string }>(
      'SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND card_type IS NULL',
      [workspace.roomId, beebee.agent_id],
    )).rows;
    expect(hello).toHaveLength(1);
    expect(hello[0]!.text).toContain("@alex.chen Hi, I'm Beebee");
    expect(hello[0]!.text).not.toContain(google.identityId);
    const room = await phone.readRoom(workspace.roomId!, google.identityId);
    expect(room?.room.name).toBe('general');
    expect(room?.messages.some(message => message.onboarding)).toBe(false);
    expect((await db.query('SELECT github_subject FROM identities WHERE id=$1', [google.identityId])).rows[0]?.github_subject).toBeNull();
  });

  it('posts the exact hello and notifies the owner without a model turn or Machine boot', async () => {
    // The owner registers their device before creating the Workspace.
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
      VALUES('hello-owner-device-1234567890',$1,'android','physical',now()-interval '1 minute')`, [OWNER]);
    await db.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 minute')`);
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Fresh' }, OWNER) as { id: string; roomId: string };
    const agent = await freeAgentOf(id);
    expect(agent.state).toMatch(/provisioning|waking/);

    const identity = (
      await db.query<{ kind: string; name: string; handle: string | null; owner_id: string; selected_model: string; soul: { name: string; instructions: string } }>(
        `SELECT i.kind,i.name,i.handle,a.owner_id,a.selected_model,a.harness,a.soul FROM identities i
         JOIN agents a ON a.agent_id=i.id WHERE i.id=$1`,
        [agent.agent_id],
      )
    ).rows[0]!;
    expect(identity).toMatchObject({
      kind: 'agent',
      name: 'Beebee',
      handle: 'beebee',
      owner_id: OWNER,
      selected_model: 'beeline/deepseek/deepseek-v4-flash',
      harness: 'pi',
    });
    expect(identity.soul.name).toBe('Beebee');
    expect(identity.soul.instructions).toContain('You are Beebee');
    // A member of the Workspace and of #general, created in the same transaction.
    expect(
      (
        await db.query(
          `SELECT room_id FROM memberships WHERE identity_id=$1 AND removed_at IS NULL ORDER BY room_id NULLS FIRST`,
          [agent.agent_id],
        )
      ).rows,
    ).toEqual([{ room_id: null }, { room_id: roomId }]);
    const hello = (await db.query<{ id: string; text: string }>(
      `SELECT id,text FROM messages WHERE room_id=$1 AND author_id=$2 AND card_type IS NULL`, [roomId, agent.agent_id],
    )).rows;
    const expected = `@lunchboxfortwo Hi, I'm Beebee, your free agent. I run on my own small cloud computer, so I can research, write, draft, build things and run code for you.

Three things to know:
- **Talk to me here.** Tag @beebee, or just type while I'm the only agent in this Room.
- **Big jobs get a corner.** That's a side thread where I plan, do and check the work, then bring you one thing to approve. Tap it to follow along.
- **Connect once, use everywhere.** Link your apps in Connectors and every agent here can use them. You can also add your own agents, like Claude Code or Codex, from Members.

What are you working on? Tell me, and I'll take the first step with you. If you'd rather not have me here, remove me from Members.`;
    expect((await phone.readRoom(roomId, OWNER))?.messages.some(message => message.onboarding)).toBe(false);
    expect(hello).toHaveLength(1);
    expect(hello[0]!.text).toBe(expected);
    expect(FREE_AGENT_HELLO.replace('<owner>', 'lunchboxfortwo').replace('<handle>', 'beebee')).toBe(expected);
    expect(await resolveCurrentMemberMentions(db, roomId, expected, agent.agent_id)).toEqual([{ id: OWNER, kind: 'human', handle: 'lunchboxfortwo' }]);
    expect((await db.query(`SELECT 1 FROM push_outbox
      WHERE message_id=$1 AND device_token='hello-owner-device-1234567890'`, [hello[0]!.id])).rowCount).toBe(1);
    const delivered: Array<{ messageId: string; recipientIdentityId?: string }> = [];
    await new PushDeliveryLoop(db, { send: async (_token, message) => { delivered.push(message); } }).runOnce();
    expect(delivered).toContainEqual(expect.objectContaining({ messageId: hello[0]!.id, recipientIdentityId: OWNER }));
    await freeAgents.sweep();
    await settle();
    expect(machines.calls).toEqual([]);
    expect(exchanges).toEqual([]);
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [agent.agent_id])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM free_agent_events WHERE agent_id=$1 AND kind='model_usage'`, [agent.agent_id])).rowCount).toBe(0);
    // Reachable before its Machine ever booted.
    const presence = (
      await db.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
        [agent.agent_id],
      )
    ).rows[0]!.body;
    expect(presence).toMatchObject({ status: 'online', held: true, asleep: true });

    // Only actual work provisions its Machine.
    await createAgentCommand(db, { roomId, agentId: agent.agent_id, sourceMessageId: null, reason: 'human_tag' });
    await freeAgents.provision(agent.agent_id);
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

  it('keeps the Beebee name and de-duplicates its handle against existing members', async () => {
    await db.query(`UPDATE identities SET handle='beebee' WHERE id=$1`, [OWNER]);
    const { id } = await createWorkspace();
    const agent = await freeAgentOf(id);
    const identity = (await db.query<{ name: string; handle: string }>(
      `SELECT name,handle FROM identities WHERE id=$1`, [agent.agent_id],
    )).rows[0];
    expect(identity).toEqual({ name: 'Beebee', handle: 'beebee_2' });
    expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agent.agent_id])).rows[0]!.text).toBe(FREE_AGENT_HELLO.replace('<owner>', 'beebee').replace('<handle>', 'beebee_2'));
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
      harness: 'pi',
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
    // The owner request is still pending: no sleep.
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

  describe('start limit', () => {
    const passFence = (agentId: string) =>
      db.query(`UPDATE free_agents SET wake_requested_at=now()-interval '21 seconds' WHERE agent_id=$1`, [agentId]);
    const startOnce = async (agentId: string) => {
      await passFence(agentId);
      return freeAgents.wake(agentId);
    };
    const startNotices = async (roomId: string) =>
      (
        await db.query<{ author_id: string; text: string }>(
          `SELECT author_id,text FROM messages WHERE room_id=$1 AND text LIKE '%could not start%' ORDER BY created_at`,
          [roomId],
        )
      ).rows;

    it('FA-START-LIMIT-1: stops a Machine that never connects after 5 starts, tells the person once and alerts Sentry once', async () => {
      const { id, roomId } = await createWorkspace();
      await settle();
      const agent = await freeAgentOf(id);
      const handle = (await db.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [agent.agent_id]))
        .rows[0]!.handle;
      await db.query(`UPDATE agent_commands SET created_at=now()-interval '1 minute' WHERE agent_id=$1`, [agent.agent_id]);
      machines.calls.length = 0;
      // Start always succeeds and the helper never connects; the sweep runs past every 20-second fence.
      for (let sweep = 0; sweep < 10; sweep++) {
        await passFence(agent.agent_id);
        await freeAgents.sweep();
      }
      expect(machines.calls).toEqual([...Array(5).fill('start m1'), 'stop m1']);
      expect(await freeAgentOf(id)).toMatchObject({ state: 'stopped' });
      expect(await startNotices(roomId)).toEqual([
        {
          author_id: agent.agent_id,
          text: `@${handle} could not start for @lunchboxfortwo · the Beeline team has been told. Send a new message to try again`,
        },
      ]);
      expect(sentryCaptures).toHaveLength(1);
      expect(sentryCaptures[0]!.tags).toEqual({
        area: 'free-agent-start-limit',
        agentId: agent.agent_id,
        machineId: 'm1',
        starts: '5',
      });
      expect(String(sentryCaptures[0]!.error)).toContain('never connected after 5 starts in 10 minutes');
      expect(
        (await db.query(`SELECT 1 FROM free_agent_events WHERE agent_id=$1 AND kind='start_limit_reached'`, [agent.agent_id]))
          .rowCount,
      ).toBe(1);
    });

    it('resets the count when the helper connects', async () => {
      const { id } = await createWorkspace();
      await settle();
      const agent = await freeAgentOf(id);
      for (let start = 0; start < 4; start++) expect(await startOnce(agent.agent_id)).toBe(true);
      await db.query(
        `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('server-1',now()) ON CONFLICT DO NOTHING`,
      );
      await claimAgentConnection(db, live, agent.agent_id, { lifecycleId: 'life-1' }, {
        connectionId: 'conn-1',
        instanceId: 'server-1',
      });
      await releaseAgentConnection(db, live, agent.agent_id, 'conn-1');
      for (let start = 0; start < 5; start++) expect(await startOnce(agent.agent_id)).toBe(true);
      expect(await startOnce(agent.agent_id)).toBe(false);
      expect(sentryCaptures).toHaveLength(1);
    });

    it('keeps the stop when a person joins or leaves the Workspace', async () => {
      const { id } = await createWorkspace();
      const workspaceId = id;
      await settle();
      const agent = await freeAgentOf(id);
      for (let start = 0; start < 5; start++) expect(await startOnce(agent.agent_id)).toBe(true);
      expect(await startOnce(agent.agent_id)).toBe(false);
      machines.calls.length = 0;
      // Join and leave post System lines with a human author; neither is a retry.
      await phone.execute('addWorkspaceMember', { workspaceId, memberId: FRIEND, role: 'member' }, OWNER);
      await settle();
      expect(await startOnce(agent.agent_id)).toBe(false);
      await phone.execute('removeWorkspaceMember', { workspaceId, memberId: FRIEND }, OWNER);
      await settle();
      expect(await startOnce(agent.agent_id)).toBe(false);
      await passFence(agent.agent_id);
      await freeAgents.sweep();
      expect(machines.calls).toEqual([]);
      expect(sentryCaptures).toHaveLength(1);
    });

    it('lets a new human message open one fresh episode after the stop', async () => {
      const { id, roomId } = await createWorkspace();
      await settle();
      const agent = await freeAgentOf(id);
      for (let start = 0; start < 5; start++) expect(await startOnce(agent.agent_id)).toBe(true);
      expect(await startOnce(agent.agent_id)).toBe(false);
      // Repeated sweeps and wakes during the stop start nothing and post nothing.
      machines.calls.length = 0;
      for (let retry = 0; retry < 3; retry++) {
        expect(await startOnce(agent.agent_id)).toBe(false);
        await freeAgents.sweep();
      }
      expect(machines.calls).toEqual([]);
      expect(await startNotices(roomId)).toHaveLength(1);
      expect(sentryCaptures).toHaveLength(1);

      const handle = (await db.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [agent.agent_id]))
        .rows[0]!.handle;
      await phone.execute(
        'sendRoomMessage',
        { roomId, messageId: '7'.repeat(64), text: `@${handle} try again`, mentions: [agent.agent_id] },
        OWNER,
      );
      await settle();
      const kicked = machines.calls.filter((call) => call === 'start m1').length;
      for (let start = kicked; start < 5; start++) expect(await startOnce(agent.agent_id)).toBe(true);
      expect(machines.calls.filter((call) => call === 'start m1')).toHaveLength(5);
      expect(await startOnce(agent.agent_id)).toBe(false);
      expect(await startNotices(roomId)).toHaveLength(2);
      expect(sentryCaptures).toHaveLength(2);
    });
  });

  it('does not start or provision Machines after the shared budget is reached', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await db.query(`UPDATE free_agents SET state='sleeping' WHERE agent_id=$1`, [agent.agent_id]);
    await db.query(`INSERT INTO free_agent_budget(day,usd) VALUES(current_date,25)`);
    machines.calls.length = 0;
    expect(await freeAgents.wake(agent.agent_id)).toBe(false);
    await db.query(`UPDATE free_agents SET state='destroyed',fly_machine_id=NULL WHERE agent_id=$1`, [agent.agent_id]);
    expect(await freeAgents.provision(agent.agent_id)).toBe(false);
    expect(machines.calls).toEqual([]);
    expect((await db.query(`SELECT kind FROM free_agent_events WHERE kind='budget_reached'`)).rows).toHaveLength(2);
  });

  it('FREE-ABUSE-1: reaps a Machine when its command passes the hard cap plus grace', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await db.query(`UPDATE free_agents SET state='running',last_activity_at=now(),
      wake_requested_at=now() WHERE agent_id=$1`, [agent.agent_id]);
    await db.query(`UPDATE agent_commands SET state='claimed',claimed_at=now()-interval '17 minutes',
      lease_expires_at=now()+interval '90 seconds' WHERE agent_id=$1`, [agent.agent_id]);
    machines.calls.length = 0;
    await freeAgents.sweep();
    expect(machines.calls).toContain('stop m1');
    const closed = await db.query(`SELECT text FROM messages WHERE card->>'freeAgentClosed'='true'`);
    expect(closed.rows).toHaveLength(1);
    expect(closed.rows[0].text).toContain('15-minute limit');
    await freeAgents.sweep();
    expect((await db.query(`SELECT id FROM messages WHERE card->>'freeAgentClosed'='true'`)).rowCount).toBe(1);
    expect((await db.query(`SELECT state,cancellation_reason FROM agent_commands WHERE agent_id=$1`, [agent.agent_id])).rows)
      .toEqual([{ state: 'cancelled', cancellation_reason: 'free-agent-time-limit' }]);
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
    const additions = await Promise.all([
      addFreeAgentToWorkspace(db, freeAgents, workspaceId),
      addFreeAgentToWorkspace(db, freeAgents, workspaceId),
    ]);
    expect(additions.filter(Boolean)).toHaveLength(1);
    const agentId = additions.find(Boolean);
    expect(agentId).toBeTruthy();
    expect(machines.calls).toEqual([]);
    const hello = (await db.query<{ text: string }>(`SELECT text FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agentId])).rows;
    expect(hello).toEqual([{ text: FREE_AGENT_HELLO.replace('<owner>', 'lunchboxfortwo').replace('<handle>', 'beebee') }]);
    await freeAgents.sweep();
    expect(machines.calls).toEqual([]);
    expect(
      (await db.query(`SELECT owner_id FROM free_agents WHERE agent_id=$1`, [agentId])).rows,
    ).toEqual([{ owner_id: OWNER }]);
    expect(
      (
        await db.query(`SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL`, [agentId])
      ).rows,
    ).toEqual([{ room_id: general }]);
    expect(await addFreeAgentToWorkspace(db, freeAgents, workspaceId)).toBeUndefined();
    expect((await db.query(`SELECT 1 FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agentId])).rowCount).toBe(1);
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

    // The person leaves #general: the next sweep queues one wake on the leave line.
    await phone.execute('leaveRoom', { roomId }, FRIEND);
    expect(await freeAgents.sweep()).toBeGreaterThanOrEqual(1);
    expect((await wakes()).at(-1)).toBe('@friend left');
    // Each leave is one wake, never repeated.
    await freeAgents.sweep();
    expect(await wakes()).toHaveLength(2);
    // A removal by an admin is a leave too.
    await phone.execute('addRoomMember', { roomId, memberIds: [FRIEND] }, OWNER);
    await phone.execute('removeRoomMember', { roomId, memberId: FRIEND }, OWNER);
    await freeAgents.sweep();
    expect((await wakes()).at(-1)).toBe('@lunchboxfortwo removed @friend');
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
    expect(soul).not.toContain('When you first join, greet');
    expect(soul).toContain('The server already posts your first hello');
    expect(soul).toContain('Never greet an agent.');
  });

  it('removes Beebee through Members, revokes bootstrap and never recreates it on a mention or wake', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const bootstrap = machines.specs[0]!.env.BEELINE_FREE_AGENT_BOOTSTRAP!;
    const grant = await freeAgents.bootstrap(bootstrap);
    expect(grant?.modelToken).toBeTruthy();
    await phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, OWNER);
    await settle();
    expect(machines.calls).toContain('destroy m1');
    const removed = (await db.query(`SELECT removed_at,bootstrap_hash,model_token_hash FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0]!;
    expect(removed.removed_at).toBeTruthy();
    expect(removed.bootstrap_hash).toBeNull();
    expect(removed.model_token_hash).toBeNull();
    expect(await freeAgents.bootstrap(bootstrap)).toBeUndefined();
    machines.calls.length = 0;
    await phone.execute('sendRoomMessage', { roomId, messageId: '8'.repeat(64), text: '@beebee are you there?', mentions: [agent.agent_id] }, OWNER);
    freeAgents.kickIfFree(agent.agent_id);
    freeAgents.kick(agent.agent_id);
    expect(await freeAgents.wake(agent.agent_id)).toBe(false);
    expect(await freeAgents.provision(agent.agent_id)).toBe(false);
    expect(await freeAgents.requestSleep(agent.agent_id)).toEqual({ sleep: false });
    expect(await addFreeAgentToWorkspace(db, freeAgents, id)).toBeUndefined();
    await freeAgents.sweep();
    await settle();
    expect(machines.calls).toEqual([]);
    expect((await db.query(`SELECT kind FROM free_agent_events WHERE agent_id=$1 AND kind='removed'`, [agent.agent_id])).rows).toHaveLength(1);
  });

  it.each(['owner', 'admin'])('allows a Workspace %s to remove another person\'s Beebee', async role => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await phone.execute('addWorkspaceMember', { workspaceId: id, memberId: FRIEND, role }, OWNER);
    await phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, FRIEND);
    await settle();
    expect(machines.states.get('m1')).toBe('destroyed');
    expect((await db.query(`SELECT model_token_hash,removed_at FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ model_token_hash: null, removed_at: expect.any(Date) });
  });

  it('retires a free agent even when it is removed from another Workspace it joined', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const other = '77777777-7777-4777-8777-777777777777';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [other]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [other, FRIEND, agent.agent_id]);
    await phone.execute('removeAgent', { workspaceId: other, agentId: agent.agent_id }, FRIEND);
    await settle();
    expect(machines.states.get('m1')).toBe('destroyed');
    expect(await freeAgents.wake(agent.agent_id)).toBe(false);
    expect(await addFreeAgentToWorkspace(db, freeAgents, id)).toBeUndefined();
  });

  it('commits removal despite Fly deletion failure and retries it in the leader sweep', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    machines.failDestroy = true;
    let deletionStarted!: () => void;
    let releaseDelete!: () => void;
    const started = new Promise<void>(resolve => { deletionStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseDelete = resolve; });
    machines.beforeDestroy = async () => { deletionStarted(); await blocked; };
    const removal = phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, OWNER);
    await started;
    try {
      expect(await Promise.race([removal.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])).toBe(true);
    } finally {
      releaseDelete();
      await removal;
    }
    await settle();
    machines.beforeDestroy = undefined;
    expect((await db.query(`SELECT removed_at,removal_cleaned_at,fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ removed_at: expect.any(Date), removal_cleaned_at: null, fly_machine_id: 'm1' });
    machines.failDestroy = false;
    machines.calls.length = 0;
    await freeAgents.sweep();
    expect(machines.calls).toEqual(['destroy m1']);
    expect((await db.query(`SELECT removal_cleaned_at,fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ removal_cleaned_at: expect.any(Date), fly_machine_id: null });
    machines.calls.length = 0;
    await freeAgents.sweep();
    expect(machines.calls).toEqual([]);
  });

  it('cleans up a Machine whose provisioning finishes after removal without restoring its bootstrap', async () => {
    let release!: () => void;
    let entered!: () => void;
    const creating = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    machines.beforeCreate = async () => { entered(); await finish; };
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Race' }, OWNER) as { id: string; roomId: string };
    const pending = await freeAgentOf(id);
    await createAgentCommand(db, { roomId, agentId: pending.agent_id, sourceMessageId: null, reason: 'human_tag' });
    freeAgents.kick(pending.agent_id);
    await creating;
    const agent = await freeAgentOf(id);
    await phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, OWNER);
    release();
    await settle();
    expect(machines.calls.filter(call => call.startsWith('create '))).toEqual([`create ${agent.agent_id.slice(0, 4)}`]);
    expect(machines.states.get('m1')).toBe('destroyed');
    expect((await db.query(`SELECT removed_at,bootstrap_hash,fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ removed_at: expect.any(Date), bootstrap_hash: null, fly_machine_id: null });
    await freeAgents.sweep();
    expect(machines.specs).toHaveLength(1);
  });

  it('generates keys in the helper identity format', () => {
    const pair = generateAgentKeypair();
    expect(pair.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(Buffer.from(pair.secretKey, 'hex'))).toBe(pair.publicKey);
    expect(createECDH('secp256k1')).toBeTruthy();
  });
});

it('defaults free agents to the October V4.1 Flash update and preserves an explicit model override', () => {
  const env = { BEELINE_FREE_AGENT_SEAL_KEY: 'seal', FLY_FREE_AGENT_IMAGE: 'image' };
  expect(freeAgentConfigFromEnv(env, 'https://server.test')?.model).toBe('deepseek/deepseek-v4.1-flash-1017');
  expect(freeAgentConfigFromEnv({ ...env, BEELINE_FREE_AGENT_MODEL: 'custom/model' }, 'https://server.test')?.model).toBe('custom/model');
});
