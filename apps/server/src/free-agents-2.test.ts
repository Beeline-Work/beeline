import { migrateMembershipSubscriptions, createECDH, getPublicKey, describe, expect, it, createAgentCommand, claimAgentConnection, releaseAgentConnection, addFreeAgentToWorkspace, FREE_AGENT_EXIT_NOTE, FREE_AGENT_HELLO, FREE_AGENT_JOIN_GREETING, generateAgentKeypair, freeAgentConfigFromEnv, sentryCaptures, OWNER, FRIEND, settle, fixtureScope1, fixtureScope2 } from './free-agents.test-support.js';

describe('free starter agents', () => {
const scope1 = fixtureScope1();


  it('sweeps: retries provisioning, wakes an overdue wake, reaps an idle Machine, deletes after 30 days and recreates on wake', async () => {
    const { id, roomId } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    await scope1.db.query(`UPDATE agent_commands SET state='complete',completed_at=now()-interval '1 hour' WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    // A running Machine with no work for longer than the reap window.
    await scope1.db.query(
      `UPDATE free_agents SET state='running',last_activity_at=now()-interval '10 minutes',
         wake_requested_at=now()-interval '10 minutes' WHERE agent_id=$1`,
      [agent.agent_id],
    );
    scope1.machines.calls.length = 0;
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).toEqual(['suspend m1']);
    expect(await scope1.freeAgentOf(id)).toMatchObject({ state: 'sleeping' });

    // Thirty days with no activity: the Machine is deleted.
    await scope1.db.query(`UPDATE free_agents SET last_activity_at=now()-interval '31 days' WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    await scope1.db.query(`UPDATE agent_commands SET created_at=now()-interval '31 days' WHERE agent_id=$1`, [
      agent.agent_id,
    ]);
    scope1.machines.calls.length = 0;
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).toEqual(['destroy m1']);
    expect(await scope1.freeAgentOf(id)).toMatchObject({ state: 'destroyed', fly_machine_id: null });

    // A later wake recreates the Machine (the agent and its identity are kept).
    const source = 'f'.repeat(64);
    await scope1.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'are you there?')`, [
      source,
      roomId,
      OWNER,
    ]);
    await createAgentCommand(scope1.db, {
      roomId,
      agentId: agent.agent_id,
      sourceMessageId: source,
      reason: 'human_tag',
      id: 'e'.repeat(64),
    });
    await scope1.db.query(`UPDATE agent_commands SET created_at=now()-interval '1 minute' WHERE id=$1`, [
      'e'.repeat(64),
    ]);
    scope1.machines.calls.length = 0;
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).toEqual([`create ${agent.agent_id.slice(0, 4)}`]);
    expect(await scope1.freeAgentOf(id)).toMatchObject({ state: 'waking', fly_machine_id: 'm2' });
  });
describe('start limit', () => {
const scope2 = fixtureScope2(scope1);


    it('FA-START-LIMIT-1: stops a Machine that never connects after 5 starts, tells the person once and alerts Sentry once', async () => {
      const { id, roomId } = await scope1.createWorkspace();
      await settle();
      const agent = await scope1.freeAgentOf(id);
      const handle = (await scope1.db.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [agent.agent_id]))
        .rows[0]!.handle;
      await scope1.db.query(`UPDATE agent_commands SET created_at=now()-interval '1 minute' WHERE agent_id=$1`, [agent.agent_id]);
      scope1.machines.calls.length = 0;
      // Start always succeeds and the helper never connects; the sweep runs past every 20-second fence.
      for (let sweep = 0; sweep < 10; sweep++) {
        await scope2.passFence(agent.agent_id);
        await scope1.freeAgents.sweep();
      }
      expect(scope1.machines.calls).toEqual([...Array(5).fill('start m1'), 'stop m1']);
      expect(await scope1.freeAgentOf(id)).toMatchObject({ state: 'stopped' });
      expect(await scope2.startNotices(roomId)).toEqual([
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
        (await scope1.db.query(`SELECT 1 FROM free_agent_events WHERE agent_id=$1 AND kind='start_limit_reached'`, [agent.agent_id]))
          .rowCount,
      ).toBe(1);
    });


    it('resets the count when the helper connects', async () => {
      const { id } = await scope1.createWorkspace();
      await settle();
      const agent = await scope1.freeAgentOf(id);
      for (let start = 0; start < 4; start++) expect(await scope2.startOnce(agent.agent_id)).toBe(true);
      await scope1.db.query(
        `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('server-1',now()) ON CONFLICT DO NOTHING`,
      );
      await claimAgentConnection(scope1.db, scope1.live, agent.agent_id, { lifecycleId: 'life-1' }, {
        connectionId: 'conn-1',
        instanceId: 'server-1',
      });
      await releaseAgentConnection(scope1.db, scope1.live, agent.agent_id, 'conn-1');
      for (let start = 0; start < 5; start++) expect(await scope2.startOnce(agent.agent_id)).toBe(true);
      expect(await scope2.startOnce(agent.agent_id)).toBe(false);
      expect(sentryCaptures).toHaveLength(1);
    });


    it('keeps the stop when a person joins or leaves the Workspace', async () => {
      const { id } = await scope1.createWorkspace();
      const workspaceId = id;
      await settle();
      const agent = await scope1.freeAgentOf(id);
      for (let start = 0; start < 5; start++) expect(await scope2.startOnce(agent.agent_id)).toBe(true);
      expect(await scope2.startOnce(agent.agent_id)).toBe(false);
      scope1.machines.calls.length = 0;
      // Join and leave post System lines with a human author; neither is a retry.
      await scope1.phone.execute('addWorkspaceMember', { workspaceId, memberId: FRIEND, role: 'member' }, OWNER);
      await settle();
      expect(await scope2.startOnce(agent.agent_id)).toBe(false);
      await scope1.phone.execute('removeWorkspaceMember', { workspaceId, memberId: FRIEND }, OWNER);
      await settle();
      expect(await scope2.startOnce(agent.agent_id)).toBe(false);
      await scope2.passFence(agent.agent_id);
      await scope1.freeAgents.sweep();
      // The other teammate may handle the leave; this helper must stay stopped.
      const teammate = (await scope1.db.query<{ agent_id: string }>(
        `SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND agent_id<>$2`, [id, agent.agent_id])).rows[0]!;
      expect(scope1.machines.calls.filter(call => call !== `create ${teammate.agent_id.slice(0, 4)}`)).toEqual([]);
      expect(scope1.machines.specs.filter(spec => spec.agentId === agent.agent_id)).toHaveLength(1);
      expect((await scope1.freeAgentOf(id)).state).toBe('stopped');
      expect(sentryCaptures).toHaveLength(1);
    });


    it('lets a new human message open one fresh episode after the stop', async () => {
      const { id, roomId } = await scope1.createWorkspace();
      await settle();
      const agent = await scope1.freeAgentOf(id);
      for (let start = 0; start < 5; start++) expect(await scope2.startOnce(agent.agent_id)).toBe(true);
      expect(await scope2.startOnce(agent.agent_id)).toBe(false);
      // Repeated sweeps and wakes during the stop start nothing and post nothing.
      scope1.machines.calls.length = 0;
      for (let retry = 0; retry < 3; retry++) {
        expect(await scope2.startOnce(agent.agent_id)).toBe(false);
        await scope1.freeAgents.sweep();
      }
      expect(scope1.machines.calls).toEqual([]);
      expect(await scope2.startNotices(roomId)).toHaveLength(1);
      expect(sentryCaptures).toHaveLength(1);

      const handle = (await scope1.db.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [agent.agent_id]))
        .rows[0]!.handle;
      await scope1.phone.execute(
        'sendRoomMessage',
        { roomId, messageId: '7'.repeat(64), text: `@${handle} try again`, mentions: [agent.agent_id] },
        OWNER,
      );
      await settle();
      const kicked = scope1.machines.calls.filter((call) => call === 'start m1').length;
      for (let start = kicked; start < 5; start++) expect(await scope2.startOnce(agent.agent_id)).toBe(true);
      expect(scope1.machines.calls.filter((call) => call === 'start m1')).toHaveLength(5);
      expect(await scope2.startOnce(agent.agent_id)).toBe(false);
      expect(await scope2.startNotices(roomId)).toHaveLength(2);
      expect(sentryCaptures).toHaveLength(2);
    });
});


  it('does not start or provision Machines after the shared budget is reached', async () => {
    const { id } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    await scope1.db.query(`UPDATE free_agents SET state='sleeping' WHERE agent_id=$1`, [agent.agent_id]);
    await scope1.db.query(`INSERT INTO free_agent_budget(day,usd) VALUES(current_date,25)`);
    scope1.machines.calls.length = 0;
    expect(await scope1.freeAgents.wake(agent.agent_id)).toBe(false);
    await scope1.db.query(`UPDATE free_agents SET state='destroyed',fly_machine_id=NULL WHERE agent_id=$1`, [agent.agent_id]);
    expect(await scope1.freeAgents.provision(agent.agent_id)).toBe(false);
    expect(scope1.machines.calls).toEqual([]);
    expect((await scope1.db.query(`SELECT kind FROM free_agent_events WHERE kind='budget_reached'`)).rows).toHaveLength(2);
  });


  it('leaves overlong commands to model-request admission instead of a machine-stop sweep', async () => {
    const { id } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    await scope1.db.query(`UPDATE free_agents SET state='running',last_activity_at=now(),
      wake_requested_at=now() WHERE agent_id=$1`, [agent.agent_id]);
    await scope1.db.query(`UPDATE agent_commands SET state='claimed',claimed_at=now()-interval '17 minutes',
      lease_expires_at=now()+interval '90 seconds' WHERE agent_id=$1`, [agent.agent_id]);
    scope1.machines.calls.length = 0;
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).not.toContain('stop m1');
    expect((await scope1.db.query(`SELECT state FROM agent_commands WHERE agent_id=$1`,[agent.agent_id])).rows)
      .toEqual([{state:'claimed'}]);
    expect((await scope1.db.query(`SELECT id FROM messages WHERE card_type='turn-failed'`)).rows).toEqual([]);

  });


  it('adds one free agent to an existing Workspace in its #general, owned by its owner', async () => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Old')`, [workspaceId]);
    await scope1.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [workspaceId, OWNER, FRIEND],
    );
    const lounge = '55555555-5555-4555-8555-555555555555';
    const general = '66666666-6666-4666-8666-666666666666';
    await scope1.db.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,created_at) VALUES
        ($1,$3,$4,'lounge','public',now()-interval '2 days'),($2,$3,$4,'general','public',now()-interval '1 day')`,
      [lounge, general, workspaceId, OWNER],
    );
    const additions = await Promise.all([
      addFreeAgentToWorkspace(scope1.db, scope1.freeAgents, workspaceId),
      addFreeAgentToWorkspace(scope1.db, scope1.freeAgents, workspaceId),
    ]);
    expect(additions.filter(Boolean)).toHaveLength(1);
    const agentId = additions.find(Boolean);
    expect(agentId).toBeTruthy();
    expect(scope1.machines.calls).toEqual([]);
    const hello = (await scope1.db.query<{ text: string }>(`SELECT text FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agentId])).rows;
    expect(hello).toEqual([{ text: FREE_AGENT_HELLO.replace('<owner>', 'lunchboxfortwo').replace('<handle>', 'beebee') }]);
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).toEqual([]);
    expect(
      (await scope1.db.query(`SELECT owner_id FROM free_agents WHERE agent_id=$1`, [agentId])).rows,
    ).toEqual([{ owner_id: OWNER }]);
    expect(
      (
        await scope1.db.query(`SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL`, [agentId])
      ).rows,
    ).toEqual([{ room_id: general }]);
    expect(await addFreeAgentToWorkspace(scope1.db, scope1.freeAgents, workspaceId)).toBeUndefined();
    expect((await scope1.db.query(`SELECT 1 FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agentId])).rowCount).toBe(1);
  });


  it('hears #general joins and leaves from creation', async () => {
    const { id, roomId } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    expect(
      (
        await scope1.db.query(`SELECT event_subscriptions FROM room_access WHERE identity_id=$1 AND room_id=$2`, [
          agent.agent_id,
          roomId,
        ])
      ).rows,
    ).toEqual([{ event_subscriptions: ['joined', 'left'] }]);
    const wakes = async () =>
      (
        await scope1.db.query<{ text: string }>(
          `SELECT source.text FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
           WHERE command.agent_id=$1 AND command.reason='subscribed_event' ORDER BY command.created_at`,
          [agent.agent_id],
        )
      ).rows.map((row) => row.text);

    // A person joins the Workspace: one joined event in #general wakes the free agent.
    await scope1.phone.execute('addWorkspaceMember', { workspaceId: id, memberId: FRIEND, role: 'member' }, OWNER);
    expect(await wakes()).toEqual(['@friend joined · invited by @lunchboxfortwo']);

    // Leave producers use the same event dispatch as joins, before any sweep.
    await scope1.phone.execute('leaveRoom', { roomId }, FRIEND);
    expect((await wakes()).at(-1)).toBe('@friend left');
    await scope1.freeAgents.sweep();
    // Each leave is one wake, never repeated.
    await scope1.freeAgents.sweep();
    expect(await wakes()).toHaveLength(2);
    // A removal by an admin is a leave too.
    await scope1.phone.execute('addRoomMember', { roomId, memberIds: [FRIEND] }, OWNER);
    await scope1.phone.execute('removeRoomMember', { roomId, memberId: FRIEND }, OWNER);
    expect((await wakes()).at(-1)).toBe('@lunchboxfortwo removed @friend');
    await scope1.freeAgents.sweep();
    expect(await wakes()).toHaveLength(4);
    // A recent unkinded fact from the preceding image retains its owed wake at upgrade.
    await scope1.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,system_event)
      VALUES('legacy-leave',$1,$2,'Legacy leave','system','member-left',$3::jsonb,'{"verb":"left"}')`,[roomId,FRIEND,JSON.stringify({identityId:FRIEND})]);
    await migrateMembershipSubscriptions(scope1.db);
    await migrateMembershipSubscriptions(scope1.db);
    expect((await wakes()).at(-1)).toBe('Legacy leave');
    expect(await wakes()).toHaveLength(5);
  });


  it('carries the owner\'s exact join greeting and the exit note in the free agent\'s instructions', async () => {
    const { id } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    const soul = (
      await scope1.db.query<{ soul: { instructions: string } }>(`SELECT soul FROM agents WHERE agent_id=$1`, [
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
    const { id, roomId } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    const bootstrap = scope1.machines.specs[0]!.env.BEELINE_FREE_AGENT_BOOTSTRAP!;
    const grant = await scope1.freeAgents.bootstrap(bootstrap);
    expect(grant?.modelToken).toBeTruthy();
    await scope1.phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, OWNER);
    await settle();
    expect(scope1.machines.calls).toContain('destroy m1');
    const removed = (await scope1.db.query(`SELECT removed_at,bootstrap_hash,model_token_hash FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0]!;
    expect(removed.removed_at).toBeTruthy();
    expect(removed.bootstrap_hash).toBeNull();
    expect(removed.model_token_hash).toBeNull();
    expect(await scope1.freeAgents.bootstrap(bootstrap)).toBeUndefined();
    scope1.machines.calls.length = 0;
    await scope1.phone.execute('sendRoomMessage', { roomId, messageId: '8'.repeat(64), text: '@beebee are you there?', mentions: [agent.agent_id] }, OWNER);
    scope1.freeAgents.kickIfFree(agent.agent_id);
    scope1.freeAgents.kick(agent.agent_id);
    expect(await scope1.freeAgents.wake(agent.agent_id)).toBe(false);
    expect(await scope1.freeAgents.provision(agent.agent_id)).toBe(false);
    expect(await scope1.freeAgents.requestSleep(agent.agent_id)).toEqual({ sleep: false });
    expect(await addFreeAgentToWorkspace(scope1.db, scope1.freeAgents, id)).toBeUndefined();
    await scope1.freeAgents.sweep();
    await settle();
    expect(scope1.machines.calls).toEqual([]);
    expect((await scope1.db.query(`SELECT kind FROM free_agent_events WHERE agent_id=$1 AND kind='removed'`, [agent.agent_id])).rows).toHaveLength(1);
  });


  it.each(['owner', 'admin'])('allows a Workspace %s to remove another person\'s Beebee', async role => {
    const { id } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    await scope1.phone.execute('addWorkspaceMember', { workspaceId: id, memberId: FRIEND, role }, OWNER);
    await scope1.phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, FRIEND);
    await settle();
    expect(scope1.machines.states.get('m1')).toBe('destroyed');
    expect((await scope1.db.query(`SELECT model_token_hash,removed_at FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ model_token_hash: null, removed_at: expect.any(Date) });
  });


  it('retires a free agent even when it is removed from another Workspace it joined', async () => {
    const { id } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    const other = '77777777-7777-4777-8777-777777777777';
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [other]);
    await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [other, FRIEND, agent.agent_id]);
    await scope1.phone.execute('removeAgent', { workspaceId: other, agentId: agent.agent_id }, FRIEND);
    await settle();
    expect(scope1.machines.states.get('m1')).toBe('destroyed');
    expect(await scope1.freeAgents.wake(agent.agent_id)).toBe(false);
    expect(await addFreeAgentToWorkspace(scope1.db, scope1.freeAgents, id)).toBeUndefined();
  });


  it('commits removal despite Fly deletion failure and retries it in the leader sweep', async () => {
    const { id } = await scope1.createWorkspace();
    await settle();
    const agent = await scope1.freeAgentOf(id);
    scope1.machines.failDestroy = true;
    let deletionStarted!: () => void;
    let releaseDelete!: () => void;
    const started = new Promise<void>(resolve => { deletionStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseDelete = resolve; });
    scope1.machines.beforeDestroy = async () => { deletionStarted(); await blocked; };
    const removal = scope1.phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, OWNER);
    await started;
    try {
      expect(await Promise.race([removal.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])).toBe(true);
    } finally {
      releaseDelete();
      await removal;
    }
    await settle();
    scope1.machines.beforeDestroy = undefined;
    expect((await scope1.db.query(`SELECT removed_at,removal_cleaned_at,fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ removed_at: expect.any(Date), removal_cleaned_at: null, fly_machine_id: 'm1' });
    scope1.machines.failDestroy = false;
    scope1.machines.calls.length = 0;
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).toEqual(['destroy m1']);
    expect((await scope1.db.query(`SELECT removal_cleaned_at,fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ removal_cleaned_at: expect.any(Date), fly_machine_id: null });
    scope1.machines.calls.length = 0;
    await scope1.freeAgents.sweep();
    expect(scope1.machines.calls).toEqual([]);
  });


  it('cleans up a Machine whose provisioning finishes after removal without restoring its bootstrap', async () => {
    let release!: () => void;
    let entered!: () => void;
    const creating = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    scope1.machines.beforeCreate = async () => { entered(); await finish; };
    const { id, roomId } = await scope1.phone.execute('createWorkspace', { name: 'Race' }, OWNER) as { id: string; roomId: string };
    await scope1.finishWelcome(roomId!, OWNER);
    const pending = await scope1.freeAgentOf(id);
    await createAgentCommand(scope1.db, { roomId, agentId: pending.agent_id, sourceMessageId: null, reason: 'human_tag' });
    scope1.freeAgents.kick(pending.agent_id);
    await creating;
    const agent = await scope1.freeAgentOf(id);
    await scope1.phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, OWNER);
    release();
    await settle();
    expect(scope1.machines.calls.filter(call => call.startsWith('create '))).toEqual([`create ${agent.agent_id.slice(0, 4)}`]);
    expect(scope1.machines.states.get('m1')).toBe('destroyed');
    expect((await scope1.db.query(`SELECT removed_at,bootstrap_hash,fly_machine_id FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ removed_at: expect.any(Date), bootstrap_hash: null, fly_machine_id: null });
    await scope1.freeAgents.sweep();
    expect(scope1.machines.specs).toHaveLength(1);
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
