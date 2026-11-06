import { describe, expect, it, vi, LiveHub, announceAgentLifecycle, ConnectionPresence, notifyAgentConfigChange, notifyConnectorAssignment, POSTGRES_LIVE_CHANNEL, postgresLiveSchema, PostgresLiveListener, seedCornerOpening, assignCornerWorker, recordCornerRun, insertCornerFacts, createAgentCommand, AUTHOR, WORKSPACE, ROOM, PgliteListenClient, eventually, settle, fixtureScope1, type LiveEvent } from './test-support-postgres-live.test-support.js';

describe('Postgres live fanout', () => {
const scope1 = fixtureScope1();


  it('carries exact Workspace and identity on committed membership insert, revoke and deletion', async () => {
    // Install this trigger revision explicitly; the root owns production markers.
    await scope1.database.query((await postgresLiveSchema()));
    const live = new LiveHub(), client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener); const received: LiveEvent[] = [];
    live.subscribeAll(event => received.push(event)); void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const changes = () => received.filter(event => event.type === 'invalidate' && event.reason === 'postgres:memberships' &&
      event.roomId === '' && event.workspaceId === WORKSPACE && event.readerId === AUTHOR && event.targetAgentId === AUTHOR);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, AUTHOR]);
    await eventually(() => changes().length === 1);
    await scope1.database.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [WORKSPACE, AUTHOR]);
    await eventually(() => changes().length === 2);
    await scope1.database.query(`DELETE FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [WORKSPACE, AUTHOR]);
    await eventually(() => changes().length === 3);
    expect(client.payloads.map(value => JSON.parse(value)).filter(value => value.table === 'memberships'))
      .toEqual(expect.arrayContaining(['INSERT','UPDATE','DELETE'].map(operation => expect.objectContaining({
        operation, workspaceId: WORKSPACE, identityId: AUTHOR, roomId: '',
      }))));
  });


  it('pushes an expired Registry OAuth attempt when its server clock ends', async () => {
    const helper = 'b'.repeat(64);
    const connector = '55555555-5555-4555-8555-555555555555';
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`, [helper]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [helper, AUTHOR]);
    await scope1.database.query(
      `INSERT INTO workspace_connectors(
        id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status,
        registry_server_name,registry_version,registry_manifest,display_name)
       VALUES($1,$2,$3,'registry-mcp',$4,$4,'installing','app.linear/linear','1.0.1',
         $5::jsonb,'Linear')`,
      [connector, WORKSPACE, AUTHOR, helper,
        JSON.stringify({ name: 'app.linear/linear', version: '1.0.1' })],
    );
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(
      `INSERT INTO registry_mcp_oauth_attempts(state,connector_id,expires_at)
       VALUES('registry-expiry-test',$1,now()+interval '100 milliseconds')`,
      [connector],
    );
    await eventually(() => received.some((event) => event.type === 'invalidate' &&
      event.reason === 'connector-assignment' && event.targetAgentId === helper));
  });


  it('names the parent Room and corner opener on a sparse corner preference invalidate', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    const corner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );


    await scope1.database.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[corner,AUTHOR]);
    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === AUTHOR &&
          event.roomId === corner &&
          event.parentRoomId === ROOM &&
          event.openedBy === AUTHOR &&
          event.removed !== true,
      ),
    );

    // Preference invalidations retain the current corner metadata.
    const opener = 'b'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [opener]);
    await insertCornerFacts(scope1.database, { cornerId: corner, ownerAgentId: opener });
    received.length = 0;
    await scope1.database.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[corner,opener]);
    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === opener &&
          event.openedBy === opener &&
          event.archived !== true,
      ),
    );

    // An existing archived corner still identifies itself on a preference change.
    await scope1.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
    const latecomer = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
      latecomer,
    ]);
    received.length = 0;


    await scope1.database.query(`INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,[corner,latecomer]);
    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === latecomer &&
          event.archived === true,
      ),
    );
  });


  it('names the parent Room and opener on a queued command for a corner this helper never watched', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const corner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const target = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
      target,
    ]);
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('tag-source',$1,$2,'@cee fix this')`,
      [corner, AUTHOR],
    );
    received.length = 0;

    await scope1.database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth
       ) VALUES($1,$2,$3,'tag-source',$4,'input','agent_tag',$1,'tag-source',0)`,
      ['command-1', corner, target, 'f'.repeat(64)],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:agent_commands' &&
          event.targetAgentId === target &&
          event.roomId === corner &&
          event.parentRoomId === ROOM &&
          event.openedBy === AUTHOR,
      ),
    );
  });


  it('marks a command released only when it leaves claimed', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const worker = 'c'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Cee')`, [
      worker,
    ]);
    await scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('work-source',$1,$2,'@cee work')`,
      [ROOM, AUTHOR],
    );
    const commandEvents = () =>
      received.filter(
        (event) => event.type === 'invalidate' && event.reason === 'postgres:agent_commands',
      );
    await scope1.database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth
       ) VALUES($1,$2,$3,'work-source',$4,'input','human_tag',$1,'work-source',0)`,
      ['work-1', ROOM, worker, 'f'.repeat(64)],
    );
    await scope1.database.query(
      `UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '90 seconds' WHERE id='work-1'`,
    );
    await scope1.database.query(
      `UPDATE agent_commands SET lease_expires_at=now()+interval '120 seconds' WHERE id='work-1'`,
    );
    await eventually(() => commandEvents().length === 3);
    expect(commandEvents().some((event) => event.type === 'invalidate' && event.commandReleased))
      .toBe(false);

    await scope1.database.query(`UPDATE agent_commands SET state='complete' WHERE id='work-1'`);
    await eventually(() => commandEvents().length === 4);
    expect(commandEvents()[3]).toMatchObject({ targetAgentId: worker, commandReleased: true });
  });


  it('nudges the parent Room only when a corner status input changes', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const parent: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => parent.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const corner = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const agent = 'e'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await insertCornerFacts(scope1.database, { cornerId: corner, ownerAgentId: agent });
    const nudges = () =>
      parent.filter((event) => event.type === 'invalidate' && event.reason === 'corner-status');
    await settle(parent);

    await scope1.database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'r1',$2,'working')`,
      [corner, agent],
    );
    await eventually(() => nudges().length === 1);
    // A heartbeat that only restamps the running turn changes no status.
    await scope1.database.query(
      `UPDATE agent_turns SET created_at=now() WHERE room_id=$1 AND request_id='r1'`,
      [corner],
    );
    await scope1.database.query(
      `UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id='r1'`,
      [corner],
    );
    await eventually(() => nudges().length === 2);
    await scope1.database.query(
      `UPDATE corner_github_cache SET lifecycle='{"lifecycle":"pr-open","checks":"pending"}'::jsonb
       WHERE corner_id=$1`,
      [corner],
    );
    await eventually(() => nudges().length === 3);
    // An approval waiting inside the corner is the parent Room's needs-you dot.
    await scope1.database.query(
      `INSERT INTO permission_authority(room_id,permission_id,principal_id,request_id,scope,status)
       VALUES($1,'perm-1',$2,'r1','{}'::jsonb,'pending')`,
      [corner, agent],
    );
    await eventually(() => nudges().length === 4);
    await scope1.database.query(
      `UPDATE permission_authority SET status='authorized' WHERE room_id=$1`,
      [corner],
    );
    await eventually(() => nudges().length === 5);
    // A top-level Room's own turn has no parent to nudge.
    await scope1.database.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'r2',$2,'working')`,
      [ROOM, agent],
    );
    await eventually(() =>
      parent.some(
        (event) => event.type === 'invalidate' && event.reason === 'postgres:agent_turns',
      ),
    );
    expect(nudges()).toHaveLength(5);
    expect(nudges()).toEqual(
      Array(5).fill({ type: 'invalidate', roomId: ROOM, reason: 'corner-status' }),
    );
  });


  it('OBJECTIVE-BRIEF: emits corner-text for opening objectives and latest brief inserts/edits', async () => {
    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const agent = 'e'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Worker')`,[agent]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,AUTHOR]);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`,[WORKSPACE,ROOM,agent]);
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
      VALUES($1,$2,$3,$4,'Goal')`,[corner,WORKSPACE,ROOM,AUTHOR]);
    const live = new LiveHub(), client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database,live,()=>client);
    scope1.listeners.push(listener);
    const parent: LiveEvent[] = [];
    live.subscribe(ROOM,event=>parent.push(event));
    void listener.run();
    await eventually(()=>client.listenerCount('notification')===1);
    const textChanged = () => parent.some(event=>event.type==='invalidate' && event.reason==='corner-text');
    const opening = await createAgentCommand(scope1.database,{roomId:corner,agentId:agent,sourceMessageId:null,
      reason:'corner_objective',privatePayload:{text:'Authorized order',objective:'Opening goal',authorId:AUTHOR,fromRoomId:ROOM,kind:'order'}});
    expect(opening).toBeDefined();
    await eventually(textChanged);
    await settle(parent);
    await scope1.database.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{objective}','"Edited goal"') WHERE id=$1`,[opening!.id]);
    await eventually(textChanged);
    await settle(parent);
    await scope1.database.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
      VALUES($1,1,'Approved scope','Brief goal',$2,$3)`,[corner,AUTHOR,ROOM]);
    await eventually(textChanged);
    await settle(parent);
    await scope1.database.query(`UPDATE corner_brief_revisions SET objective='Current goal' WHERE corner_id=$1`,[corner]);
    await eventually(textChanged);
    await settle(parent);
    await scope1.database.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
      VALUES($1,2,'New approved scope','New goal',$2,$3)`,[corner,AUTHOR,ROOM]);
    await eventually(textChanged);
    await settle(parent);
    await scope1.database.query(`UPDATE corner_brief_revisions SET objective='Historical goal' WHERE corner_id=$1 AND revision=1`,[corner]);
    await scope1.database.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{objective}','"Historical opening"') WHERE id=$1`,[opening!.id]);
    await settle([]);
    expect(textChanged()).toBe(false);
    expect(client.payloads.map(payload=>JSON.parse(payload)).filter(payload=>payload.cornerTextChanged))
      .toEqual(expect.arrayContaining([expect.objectContaining({table:'agent_commands'}),expect.objectContaining({table:'corner_brief_revisions'})]));
  });


  it('nudges the parent Room for every projected corner-row change', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const parent: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => parent.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const nudges = () =>
      parent.filter((event) => event.type === 'invalidate' && event.reason === 'corner-status');

    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const agent = 'e'.repeat(64);
    const reader = 'f'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')`, [reader]);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,[WORKSPACE,ROOM,agent,reader]);
    // A new corner is a new row in its parent's list.
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await eventually(() => nudges().length >= 1);
    await insertCornerFacts(scope1.database, { cornerId: corner, ownerAgentId: agent });
    await settle(parent);

    const expectNudge = async (write: () => Promise<unknown>) => {
      await settle(parent);
      await write();
      await eventually(() => nudges().length >= 1);
    };

    await expectNudge(() => createAgentCommand(scope1.database, {
      id: 'queued-state-proof', roomId: corner, agentId: agent, sourceMessageId: null,
      reason: 'order', privatePayload: { text: 'Continue', kind: 'order', authorId: AUTHOR, fromRoomId: ROOM },
    }));
    await expectNudge(() => scope1.database.query(`UPDATE agent_commands SET state='complete' WHERE id='queued-state-proof'`));
    // A person's tag assigns the worker through its command, not a column.
    await expectNudge(() => assignCornerWorker(scope1.database, corner, agent));
    await expectNudge(() => scope1.database.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing)
      VALUES($1,$2,'owner')`, [corner,reader]));
    await expectNudge(() => scope1.database.query(`UPDATE corner_merge_holds SET released_at=now(),released_by=$2
      WHERE corner_id=$1`, [corner,reader]));
    // Historical lifecycle cards still invalidate their visible Room transcript.
    await expectNudge(() => recordCornerRun(scope1.database, corner, 'review'));
    await expectNudge(() => recordCornerRun(scope1.database, corner, 'ask_human'));
    await expectNudge(() => scope1.database.query(
      `INSERT INTO corner_follows(corner_id,identity_id) VALUES($1,$2)`, [corner, reader]));
    await expectNudge(() => scope1.database.query(
      `DELETE FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [corner, reader]));
    await expectNudge(() => scope1.database.query(
      `INSERT INTO corner_person_state(corner_id,identity_id,subscriptions_overridden) VALUES($1,$2,true)`,
      [corner,reader]));
    await scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('owed-1',$1,$2,'question')`,
      [corner, agent]);
    await expectNudge(() => scope1.database.query(
      `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,expires_at,answerable)
       VALUES($1,$2,'owed-1',now(),now()+interval '1 hour',true)
       ON CONFLICT (message_id,person_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [corner, reader]));
    const textNudges = () => parent.filter(event => event.type === 'invalidate' && event.reason === 'corner-text');
    const priorTitleNudges = textNudges().length;
    await expectNudge(() => scope1.database.query(`UPDATE rooms SET name='renamed' WHERE id=$1`, [corner]));
    await eventually(() => textNudges().length > priorTitleNudges);
    await expectNudge(() => scope1.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, reader]));
    await expectNudge(() => scope1.database.query(
      `UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]));

    // Every other projected column: objective, initiator, row stamp,
    // brief revision and the newest chat message.
    const priorGoalNudges = textNudges().length;
    await expectNudge(() => scope1.database.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,objective,author_id,source_room_id)
       VALUES($1,1,'brief','still fix it',$2,$3)`, [corner,agent,ROOM]));
    await eventually(() => textNudges().length > priorGoalNudges);
    await expectNudge(() => scope1.database.query(`UPDATE rooms SET updated_at=now() WHERE id=$1`, [corner]));
    expect(textNudges()).toHaveLength(0);
    await expectNudge(() => seedCornerOpening(scope1.database, {
      cornerId: corner, agentId: agent, commissionedBy: reader,
    }));
    await expectNudge(() => scope1.database.query(`UPDATE rooms SET updated_at=now() WHERE id=$1`, [corner]));
    await expectNudge(() => scope1.database.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,2,'brief',$2,$3)`, [corner, agent, ROOM]));
    await expectNudge(() => scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('latest-1',$1,$2,'done')`,
      [corner, agent]));
    await expectNudge(() => scope1.database.query(
      `UPDATE messages SET text='done, edited' WHERE id='latest-1'`));
    await expectNudge(() => scope1.database.query(
      `UPDATE messages SET presentation='activity' WHERE id='latest-1'`));

    // A write that changes no corner-row column stays off the parent.
    await settle(parent);
    await scope1.database.query(`UPDATE corner_facts SET locked=locked WHERE corner_id=$1`, [corner]);
    await scope1.database.query(
      `UPDATE rooms SET repository_updated_at=now() WHERE id=$1`, [corner]);
    await scope1.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('step-1',$1,$2,'step','activity')`,
      [corner, agent]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nudges()).toEqual([]);
  });


  it('nudges the parent Room on every server machine, whichever one wrote', async () => {
    const machines = [new LiveHub(), new LiveHub()];
    const parents: LiveEvent[][] = [[], []];
    for (const [index, live] of machines.entries()) {
      const client = new PgliteListenClient(scope1.database);
      const listener = new PostgresLiveListener(scope1.database, live, () => client);
      scope1.listeners.push(listener);
      live.subscribe(ROOM, (event) => parents[index]!.push(event));
      void listener.run();
      await eventually(() => listener.projectionHealth().connected);
    }
    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccf';
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    await settle(parents[0]!);
    await settle(parents[1]!);
    // Neither machine publishes in-process: only the committed rename runs.
    await scope1.database.query(`UPDATE rooms SET name='renamed' WHERE id=$1`, [corner]);
    for (const parent of parents)
      await eventually(() => parent.some((event) =>
        event.type === 'invalidate' && event.reason === 'corner-status'));
  });


  it('delivers one parent nudge for an owed refresh that rewrites many rows', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
    const agent = 'e'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`,
      [corner, WORKSPACE, ROOM, AUTHOR],
    );
    for (const id of ['owed-a', 'owed-b', 'owed-c'])
      await scope1.database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'question')`,
        [id, corner, agent]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.payloads.length = 0;
    await scope1.database.transaction(async (db) => {
      await db.query(`DELETE FROM corner_owed WHERE corner_id=$1`, [corner]);
      for (const id of ['owed-a', 'owed-b', 'owed-c'])
        await db.query(
          `INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,answerable)
           VALUES($1,$2,$3,now(),true)`,
          [corner, AUTHOR, id]);
    });
    await eventually(() => client.payloads.some((raw) => raw.includes('"corner_owed"')));
    expect(client.payloads.filter((raw) => raw.includes('"corner_owed"'))).toHaveLength(1);
  });


  it('leaves a top-level Room membership without a corner opener', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, AUTHOR],
    );

    await eventually(() =>
      received.some(
        (event) => event.type === 'invalidate' && event.reason === 'postgres:memberships',
      ),
    );
    expect(
      received.filter((event) => event.type === 'invalidate' && event.openedBy !== undefined),
    ).toEqual([]);
  });


  it('delivers a connector-assignment wake without a catalog', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    await notifyConnectorAssignment(scope1.database, AUTHOR);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'connector-assignment' &&
            event.targetAgentId === AUTHOR,
        ),
    );
  });


  it('delivers a Squire machine-grant wake as an agent-config invalidation', async () => {
    const agent = 'b'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, agent],
    );
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    await notifyAgentConfigChange(scope1.database, agent, WORKSPACE);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'agent-config' &&
            event.targetAgentId === agent &&
            event.roomId === ROOM,
        ),
    );
  });


  it('delivers a phone-side model/effort change as an agent-config invalidation', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    // PhoneService.updateAgentModel writes this synthetic payload directly
    // inside the selection transaction — the agents table has no Room for a
    // row trigger, so the wake rides the same pg_notify channel.
    await scope1.database.query(`SELECT pg_notify($1, $2)`, [
      POSTGRES_LIVE_CHANNEL,
      JSON.stringify({ table: 'agent_config', operation: 'UPDATE', roomId: ROOM, agentId: AUTHOR }),
    ]);

    await eventually(
      () =>
        received.some(
          (event) =>
            event.type === 'invalidate' &&
            event.reason === 'agent-config' &&
            event.targetAgentId === AUTHOR &&
            event.roomId === ROOM,
        ),
    );
  });


  it('fans an agent presence fact to every joined Room on another server', async () => {
    const otherRoom = '33333333-3333-4333-8333-333333333333';
    const agent = 'b'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [
      otherRoom,
      WORKSPACE,
    ]);
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$4,'member'),($1,$3,$4,'member')`,
      [WORKSPACE, ROOM, otherRoom, agent],
    );
    const liveB = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, liveB, () => client);
    scope1.listeners.push(listener);
    void listener.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await announceAgentLifecycle(scope1.database, new LiveHub(), ROOM, agent, { lifecycleId: 'boot' });
    await eventually(() => liveB.latestAgentPresence(agent, ROOM)?.status === 'online');
    expect(liveB.latestAgentPresence(agent, otherRoom)?.status).toBe('online');
    await announceAgentLifecycle(scope1.database, new LiveHub(), otherRoom, agent, {
      lifecycleId: 'boot',
    });
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'online');
    const presenceRows = await scope1.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM live_outputs
       WHERE agent_id=$1 AND kind='presence'`,
      [agent],
    );
    expect(presenceRows.rows[0]?.count).toBe('1');
    await scope1.database.query(
      `UPDATE live_outputs SET body=body || jsonb_build_object(
      'status','offline','observedAt',(body->>'observedAt')::bigint+1) WHERE agent_id=$1`,
      [agent],
    );
    await eventually(() => liveB.latestAgentPresence(agent, otherRoom)?.status === 'offline');
    expect(liveB.latestAgentPresence(agent, ROOM)?.status).toBe('offline');
  });


  it('fans one canonical presence notification across thirty Rooms on each listener', async () => {
    const agent = 'b'.repeat(64);
    const roomIds = Array.from(
      { length: 30 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    for (const roomId of roomIds) {
      await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Load')`, [
        roomId,
        WORKSPACE,
      ]);
      await scope1.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,$2,$3,'member')`,
        [WORKSPACE, roomId, agent],
      );
    }
    for (const roomId of roomIds)
      await scope1.database.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
         VALUES($1,$2,'presence','presence',$3::jsonb)`,
        [
          roomId,
          agent,
          JSON.stringify({
            status: 'online',
            observedAt: 1,
            evidenceNonce: 'before',
            lifecycleId: 'boot',
          }),
        ],
      );
    const queryA = vi.fn(scope1.database.query.bind(scope1.database));
    const queryB = vi.fn(scope1.database.query.bind(scope1.database));
    const liveA = new LiveHub();
    const liveB = new LiveHub();
    const clientA = new PgliteListenClient(scope1.database);
    const clientB = new PgliteListenClient(scope1.database);
    const listenerA = new PostgresLiveListener(
      { query: queryA, transaction: scope1.database.transaction.bind(scope1.database) },
      liveA,
      () => clientA,
    );
    const listenerB = new PostgresLiveListener(
      { query: queryB, transaction: scope1.database.transaction.bind(scope1.database) },
      liveB,
      () => clientB,
    );
    scope1.listeners.push(listenerA, listenerB);
    void listenerA.run();
    void listenerB.run();
    await eventually(() => listenerA.projectionHealth().connected && listenerB.projectionHealth().connected);
    queryA.mockClear();
    queryB.mockClear();

    const publishA = vi.spyOn(liveA, 'publish');
    const publishB = vi.spyOn(liveB, 'publish');
    const evidence = new ConnectionPresence(scope1.database, new LiveHub());
    await evidence.evidence(roomIds[0], agent);

    await eventually(
      () =>
        liveA.latestAgentPresence(agent, roomIds[0])?.status === 'online' &&
        liveB.latestAgentPresence(agent, roomIds[0])?.status === 'online',
    );
    await evidence.stop();
    const stored = await scope1.database.query<{ body: { evidenceNonce?: string } }>(
      `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
      [agent],
    );
    expect(stored.rows.filter((row) => row.body.evidenceNonce !== 'before')).toHaveLength(1);
    expect(clientA.payloads).toHaveLength(1);
    expect(clientB.payloads).toHaveLength(1);
    expect(queryA).toHaveBeenCalledTimes(1);
    expect(queryB).toHaveBeenCalledTimes(1);
    for (const query of [queryA.mock.calls[0]?.[0], queryB.mock.calls[0]?.[0]]) {
      expect(query).toContain('SELECT membership.room_id,presence.body');
      expect(query?.match(/SELECT body FROM live_outputs/g)).toHaveLength(1);
    }
    expect(publishA).toHaveBeenCalledTimes(roomIds.length);
    expect(publishB).toHaveBeenCalledTimes(roomIds.length);
    expect([...queryA.mock.calls, ...queryB.mock.calls].map(([sql]) => sql)).toContainEqual(
      expect.stringContaining('room_access'),
    );
    for (const roomId of roomIds) {
      expect(liveA.latestAgentPresence(agent, roomId)?.status).toBe('online');
      expect(liveB.latestAgentPresence(agent, roomId)?.status).toBe('online');
    }
  });
});
