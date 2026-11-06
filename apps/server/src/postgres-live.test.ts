import { seedSquireMachine } from './test-fixtures/squire-machines.js';
import { reportSquireWork, squireWorkStatus, SENTRY_TRIAGE_ROOM, sentryEligibilityKey, AGENT_SCHEDULE_DUE_KEY, subscribeCommandCompletion, EventEmitter, describe, expect, it, vi, LiveHub, claimAgentConnection, POSTGRES_LIVE_CHANNEL, PostgresLiveListener, PhoneService, MCP_WEBHOOK_TABLE, AUTHOR, WORKSPACE, ROOM, PgliteListenClient, eventually, settle, fixtureScope1, type LiveEvent, type LivePgClient } from './test-support-postgres-live.test-support.js';

describe('Postgres live fanout', () => {
const scope1 = fixtureScope1();


  it('SENTRY-ELIGIBILITY: only committed recipient or triage authority changes wake a pending digest', async () => {
    const agent='b'.repeat(64);
    await scope1.database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Recipient')",[agent]);
    await scope1.database.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Triage')",[SENTRY_TRIAGE_ROOM,WORKSPACE,ROOM]);
    await scope1.database.query(`INSERT INTO sentry_wake_issues(issue_id,event_type,title,level,culprit,permalink,
      first_seen,last_seen,event_count,delivery_hash) VALUES('1','issue.created','Synthetic','error','','',now(),now(),1,'hash')`);
    const live=new LiveHub(),events:LiveEvent[]=[];live.subscribeAll(event=>events.push(event));
    const client=new PgliteListenClient(scope1.database),listener=new PostgresLiveListener(scope1.database,live,()=>client),wake=vi.fn();
    scope1.completionReleases.push(subscribeCommandCompletion(sentryEligibilityKey(agent),wake));
    scope1.completionReleases.push(subscribeCommandCompletion(sentryEligibilityKey('sentry'),wake));scope1.listeners.push(listener);
    void listener.run();
    // Socket readiness is not a work source.
    await eventually(()=>listener.projectionHealth().connected);expect(wake).not.toHaveBeenCalled();
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[WORKSPACE,ROOM,agent]);
    await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
    await scope1.database.query("UPDATE identities SET name='Renamed' WHERE id=$1",[agent]);
    await scope1.database.query("UPDATE rooms SET name='Renamed' WHERE id=$1",[SENTRY_TRIAGE_ROOM]);
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,[WORKSPACE,ROOM,AUTHOR]);
    await settle(events);expect(wake).not.toHaveBeenCalled();
    await expect(scope1.database.transaction(async db=>{
      await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[ROOM,agent]);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await settle(events);expect(wake).not.toHaveBeenCalled();
    await scope1.database.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[ROOM,agent]);
    await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
    await scope1.database.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[SENTRY_TRIAGE_ROOM]);
    await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
    await scope1.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('sentry-wait',$1,$2,'fixture')`,[SENTRY_TRIAGE_ROOM,AUTHOR]);
    await scope1.database.query(`INSERT INTO corner_owed(corner_id,person_id,message_id,created_at,answerable,blocking)
      VALUES($1,$2,'sentry-wait',now(),true,true)`,[SENTRY_TRIAGE_ROOM,AUTHOR]);
    await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
    await scope1.database.query("DELETE FROM corner_owed WHERE message_id='sentry-wait'");
    await eventually(()=>wake.mock.calls.length===1);wake.mockClear();
    await scope1.database.query('UPDATE sentry_wake_issues SET pending=false');
    await scope1.database.query('UPDATE rooms SET archived_at=NULL WHERE id=$1',[SENTRY_TRIAGE_ROOM]);
    await settle(events);expect(wake).not.toHaveBeenCalled();
  });


  it('SCHEDULE-DUE-SOURCE: only committed calendar and eligibility changes wake its private owner', async () => {
    const agent = 'b'.repeat(64), schedule = '33333333-3333-4333-8333-333333333333';
    await scope1.database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Scheduler')", [agent]);
    const live = new LiveHub(), events: LiveEvent[] = [];
    live.subscribeAll(event => events.push(event));
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    const wake = vi.fn(); scope1.completionReleases.push(subscribeCommandCompletion(AGENT_SCHEDULE_DUE_KEY, wake)); scope1.listeners.push(listener);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":5}','Synthetic',now()+interval '1 hour')`,
      [schedule,WORKSPACE,ROOM,agent,AUTHOR]);
    await eventually(() => wake.mock.calls.length === 1);
    await settle(events); wake.mockClear();
    await scope1.database.query("UPDATE rooms SET name='Renamed' WHERE id=$1", [ROOM]);
    await scope1.database.query("UPDATE identities SET name='Renamed' WHERE id=$1", [agent]);
    await scope1.database.query('UPDATE agent_schedules SET failed_due_at=next_run_at,failed_revision=updated_at WHERE id=$1', [schedule]);
    await settle(events); expect(wake).not.toHaveBeenCalled();
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE,ROOM,agent]);
    await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
    await scope1.database.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [ROOM,agent]);
    await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
    await scope1.database.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [ROOM]);
    await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
    await scope1.database.query('UPDATE rooms SET archived_at=NULL WHERE id=$1', [ROOM]);
    await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
    const child = '44444444-4444-4444-8444-444444444444';
    await scope1.database.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Child')", [child,WORKSPACE,ROOM]);
    await scope1.database.query('UPDATE agent_schedules SET room_id=$2 WHERE id=$1', [schedule,child]);
    await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
    // Child schedule access is inherited from this parent membership.
    await scope1.database.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [ROOM,agent]);
    await eventually(() => wake.mock.calls.length === 1); wake.mockClear();
    await expect(scope1.database.transaction(async db => {
      await db.query("UPDATE agent_schedules SET next_run_at=next_run_at+interval '1 hour' WHERE id=$1", [schedule]);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await settle(events); expect(wake).not.toHaveBeenCalled();
    await scope1.database.query("UPDATE agent_schedules SET updated_at=updated_at+interval '1 second' WHERE id=$1", [schedule]);
    await eventually(() => wake.mock.calls.length === 1);
    wake.mockClear();
    await scope1.database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent,AUTHOR]);
    await settle(events); expect(wake).not.toHaveBeenCalled(); wake.mockClear();
    await settle(events); expect(wake).not.toHaveBeenCalled(); wake.mockClear();
    const subscription = '55555555-5555-4555-8555-555555555555';
    await scope1.database.query(`INSERT INTO agent_subscriptions(id,workspace_id,room_id,agent_id,source,event,prompt)
      VALUES($1,$2,$3,$4,'room','joined',NULL)`, [subscription,WORKSPACE,ROOM,agent]);
    await settle(events); expect(wake).not.toHaveBeenCalled(); wake.mockClear();
    await scope1.database.query('UPDATE agent_subscriptions SET fired_count=fired_count+1 WHERE id=$1', [subscription]);
    await settle(events); expect(wake).not.toHaveBeenCalled();
    await scope1.database.query('UPDATE agent_subscriptions SET paused_at=now() WHERE id=$1', [subscription]);
    await settle(events); expect(wake).not.toHaveBeenCalled(); wake.mockClear();
    await scope1.database.query('UPDATE agent_schedules SET paused_at=now() WHERE id=$1', [schedule]);
    await eventually(() => wake.mock.calls.length === 1);
    expect(events.some(event => event.type === 'invalidate' && event.reason === 'postgres:agent_schedule_due')).toBe(false);
  });


  it('BRANCH-DERIVED: room archival and fact updates publish closeRequested without the retired flag', async () => {
    const corner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`, [corner, WORKSPACE, ROOM]);
    await scope1.database.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [corner]);
    const live = new LiveHub();
    const received: LiveEvent[] = [];
    live.subscribe(corner, event => received.push(event));
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
    await eventually(() => received.some(event => event.type === 'invalidate' && event.reason === 'postgres:rooms' && event.closeRequested === true));
    await scope1.database.query(`UPDATE corner_facts SET locked=locked WHERE corner_id=$1`, [corner]);
    await eventually(() => received.some(event => event.type === 'invalidate' && event.reason === 'postgres:corner_facts' && event.closeRequested === true));
    await scope1.database.query(`UPDATE corner_github_cache SET lifecycle=lifecycle WHERE corner_id=$1`, [corner]);
    await eventually(() => received.some(event => event.type === 'invalidate' && event.reason === 'postgres:corner_github_cache' && event.closeRequested === true));
  });


  it('re-arms Sentry batching on every server without publishing a Room message', async () => {
    const live = new LiveHub();
    const received: LiveEvent[] = [];
    live.subscribeAll(event => received.push(event));
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const wake = vi.fn();
    listener.setOwedWake(wake);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(`SELECT pg_notify($1,$2)`, [POSTGRES_LIVE_CHANNEL,
      JSON.stringify({ table: 'sentry_wake_state', operation: 'UPDATE', roomId: '' })]);
    await eventually(() => wake.mock.calls.length === 1);
    expect(wake).toHaveBeenCalledWith('sentry');
    expect(received).toEqual([]);
  });


  it('publishes owner-scoped install, vault and agent commits without an idle read', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const agent = 'b'.repeat(64);
    const connector = '33333333-3333-4333-8333-333333333333';
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`, [agent]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, AUTHOR]);
    await scope1.database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,owner_identity_id,connector_type,helper_agent_id)
      VALUES($1,$2,$3,'tailscale',$4)`, [connector, WORKSPACE, AUTHOR, agent]);
    await scope1.database.query(`INSERT INTO workspace_connections
      (id,connector_id,owner_identity_id,reference) VALUES($1,$2,$3,'vault-ref')`,
      ['44444444-4444-4444-8444-444444444444', connector, AUTHOR]);
    await eventually(() => ['agent', 'install', 'workbench'].every((resource) =>
      received.some((event) => event.type === 'resource-change' &&
        event.resource === resource)));
    expect(received).toContainEqual({ type: 'resource-change', roomId: '',
      ownerId: AUTHOR, resource: 'install', resourceId: connector });
    expect(received).toContainEqual({ type: 'resource-change', roomId: '',
      ownerId: AUTHOR, resource: 'workbench' });
  });


  it('MCP-DISCOVERY-1: committed public discovery invalidates only the requesting owner Workbench', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll(event => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.transaction(async db => {
      await db.query(`INSERT INTO connector_discovery_cache(cache_key,manifests,expires_at) VALUES('search:fly','[]',now()+interval '1 minute')`);
      await db.query(`SELECT pg_notify($1,$2)`, [POSTGRES_LIVE_CHANNEL,
        JSON.stringify({ table: 'connector_discovery_cache', operation: 'UPDATE', roomId: '', ownerId: AUTHOR })]);
      expect(received.filter(event => event.type === 'resource-change')).toHaveLength(0);
    });
    await eventually(() => received.some(event => event.type === 'resource-change' && event.resource === 'workbench'));
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
    expect((await scope1.database.query(`SELECT cache_key FROM connector_discovery_cache`)).rows).toEqual([{ cache_key: 'search:fly' }]);
  });


  it('wallet-2593: committed wallet revocation invalidates only the owner Workbench', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll(event => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(`INSERT INTO wallet_bindings(identity_id,workspace_id,cdp_user_id,eoa_address,delegation_standing)
      VALUES($1,$2,'wallet-test','0xabc',true)`, [AUTHOR, WORKSPACE]);
    await settle(received);
    await scope1.database.query(`UPDATE wallet_bindings SET delegation_standing=false,delegation_expires_at=NULL WHERE identity_id=$1`, [AUTHOR]);
    await eventually(() => received.some(event => event.type === 'resource-change' && event.resource === 'workbench'));
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
  });


  it('labels only isolated usage writes so negotiated clients can suppress broad agent reads',async()=>{
    const live=new LiveHub(),client=new PgliteListenClient(scope1.database);
    const listener=new PostgresLiveListener(scope1.database,live,()=>client);scope1.listeners.push(listener);
    const received:LiveEvent[]=[];live.subscribeAll(event=>received.push(event));void listener.run();
    await eventually(()=>listener.projectionHealth().connected);
    const agent='b'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')`,[agent]);
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,AUTHOR]);await settle(received);
    await scope1.database.query(`UPDATE agents SET usage_snapshot=$2::jsonb,updated_at=now() WHERE agent_id=$1`,[agent,JSON.stringify({updatedAt:1,windows:[]})]);
    await eventually(()=>received.some(event=>event.type==='resource-change'&&event.resourceId===agent));
    expect(received).toContainEqual(expect.objectContaining({type:'resource-change',resource:'agent',resourceId:agent,usageOnly:true}));
    await settle(received);
    await scope1.database.query(`UPDATE agents SET selected_model='different-model',usage_snapshot=$2::jsonb,updated_at=now() WHERE agent_id=$1`,[agent,JSON.stringify({updatedAt:2,windows:[]})]);
    await eventually(()=>received.some(event=>event.type==='resource-change'&&event.resourceId===agent));
    expect(received.find(event=>event.type==='resource-change'&&event.resourceId===agent)).not.toHaveProperty('usageOnly');
  });


  it('publishes account usage only to matching owner-bound agents and ignores metadata-only writes',async()=>{
    const live=new LiveHub(),client=new PgliteListenClient(scope1.database);
    const listener=new PostgresLiveListener(scope1.database,live,()=>client);scope1.listeners.push(listener);
    const received:LiveEvent[]=[];live.subscribeAll(event=>received.push(event));void listener.run();
    await eventually(()=>listener.projectionHealth().connected);
    const first='b'.repeat(64),second='c'.repeat(64),foreign='d'.repeat(64),otherOwner='e'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','First'),($2,'agent','Second'),($3,'agent','Foreign'),($4,'human','Other')`,[first,second,foreign,otherOwner]);
    const account=(await scope1.database.query<{id:string}>(`INSERT INTO usage_accounts(owner_id,provider,account_key,usage)
      VALUES($1,'openai','synthetic-account','{"updatedAt":1,"windows":[]}'::jsonb) RETURNING id::text`,[AUTHOR])).rows[0]!.id;
    await scope1.database.query(`INSERT INTO agents(agent_id,owner_id,usage_account_id) VALUES($1,$4,$5::bigint),($2,$4,$5::bigint),($3,$6,$5::bigint)`,[first,second,foreign,AUTHOR,account,otherOwner]);
    await settle(received);
    const before=client.payloads.filter(raw=>JSON.parse(raw).table==='usage_accounts').length;
    await scope1.database.query(`UPDATE usage_accounts SET updated_at=now() WHERE id=$1::bigint`,[account]);await settle(received);
    expect(client.payloads.filter(raw=>JSON.parse(raw).table==='usage_accounts')).toHaveLength(before);
    await scope1.database.query(`UPDATE usage_accounts SET usage='{"updatedAt":2,"windows":[]}'::jsonb,updated_at=now() WHERE id=$1::bigint`,[account]);
    await eventually(()=>received.filter(event=>event.type==='resource-change'&&event.usageOnly).length===2);
    const changes=received.filter(event=>event.type==='resource-change');
    expect(changes).toEqual([
      {type:'resource-change',roomId:'',ownerId:AUTHOR,resource:'agent',resourceId:first,usageOnly:true},
      {type:'resource-change',roomId:'',ownerId:AUTHOR,resource:'agent',resourceId:second,usageOnly:true},
    ]);
    const payload=client.payloads.map(raw=>JSON.parse(raw)).reverse().find(item=>item.table==='usage_accounts');
    expect(payload).toMatchObject({ownerId:AUTHOR,accountId:account});expect(payload).not.toHaveProperty('usage');
  });


  it('publishes machine broker reports and sign-in progress to the owner surfaces', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const agent = 'b'.repeat(64);
    await scope1.database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')", [agent]);
    await scope1.database.query("INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')",
      [agent, AUTHOR]);
    await settle(received);
    await seedSquireMachine(scope1.database, agent, { generation: 1, squire_report: { status: 'error', errorMessage: 'Squire broker unavailable', reportedAt: 1 }, squire_work: { install: true, steps: [] } });
    await eventually(() => received.some((event) => event.type === 'resource-change' && event.resource === 'workbench')
      && received.some((event) => event.type === 'resource-change' && event.resource === 'install'));
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR, resource: 'workbench' });
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR,
      resource: 'install', resourceId: 'squire:machine' });
  });


  it('refreshes an open Squire install when the vault report arrives after connect completion', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll(event => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const agent = 'b'.repeat(64);
    await scope1.database.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')", [agent]);
    await scope1.database.query("INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')",[agent,AUTHOR]);
    await seedSquireMachine(scope1.database,agent,{generation:1,
      squire_report:{status:'error',errorMessage:'Squire account sign-in required',reportedAt:1},
      squire_work:{install:true,signIn:{method:'oauth',url:'https://squire.test/install'}}});
    await settle(received);

    // ConnectorAssignmentLoop commits installConnector before refreshVault.
    await scope1.database.transaction(db => reportSquireWork(db, agent,
      { connectorId: 'squire:machine', pairingGeneration: 1, steps: [] }, true));
    await eventually(() => received.some(event => event.type === 'resource-change' && event.resource === 'install'));
    expect((await squireWorkStatus(scope1.database, agent)).status).toBe('error');
    await settle(received);

    // This later report is the first read boundary that can say connected.
    await seedSquireMachine(scope1.database,agent,{squire_report:{status:'connected',reportedAt:2}});
    await eventually(() => received.some(event => event.type === 'resource-change' && event.resource === 'workbench'));
    expect((await squireWorkStatus(scope1.database, agent)).status).toBe('connected');
    expect(received).toContainEqual({ type: 'resource-change', roomId: '', ownerId: AUTHOR,
      resource: 'install', resourceId: 'squire:machine' });
  });


  it('names a Workspace header or identity change by id, and only to who shares it', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);

    const workspaceMate = 'c'.repeat(64);
    const roomMate = 'd'.repeat(64);
    const outsider = 'e'.repeat(64);
    const otherWorkspace = '55555555-5555-4555-8555-555555555555';
    const otherRoom = '66666666-6666-4666-8666-666666666666';
    for (const [id, name] of [[workspaceMate, 'Mate'], [roomMate, 'Guest'], [outsider, 'Outsider']])
      await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human',$2)`, [id, name]);
    await scope1.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Elsewhere')`, [otherWorkspace]);
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Shared')`,
      [otherRoom, otherWorkspace, roomMate],
    );
    await scope1.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),
      ($2,NULL,$5,'owner'),($2,NULL,$6,'member'),($2,$7,$5,'owner'),($2,$7,$3,'member')`,
      [WORKSPACE, otherWorkspace, AUTHOR, workspaceMate, roomMate, outsider, otherRoom]);

    await scope1.database.query(`UPDATE workspaces SET about='no header change' WHERE id=$1`, [WORKSPACE]);
    await scope1.database.query(`UPDATE identities SET welcome_cards_due=false WHERE id=$1`, [AUTHOR]);
    await scope1.database.query(`UPDATE workspaces SET name='Renamed' WHERE id=$1`, [WORKSPACE]);
    await scope1.database.query(`UPDATE identities SET name='Author Two' WHERE id=$1`, [AUTHOR]);
    await eventually(() => events.some((event) =>
      event.type === 'invalidate' && event.reason === 'postgres:identities'));
    const changes = events.filter((event) => event.type === 'invalidate' &&
      (event.reason === 'postgres:workspaces' || event.reason === 'postgres:identities'));
    expect(changes).toEqual([
      { type: 'invalidate', roomId: '', reason: 'postgres:workspaces', workspaceId: WORKSPACE },
      { type: 'invalidate', roomId: '', reason: 'postgres:identities', personId: AUTHOR },
    ]);

    const phone = new PhoneService(scope1.database, 'http://local.test');
    const workspace = await phone.liveWorkspaceChange(WORKSPACE);
    expect(workspace?.workspace).toEqual({ id: WORKSPACE, name: 'Renamed' });
    expect([...workspace!.viewers].sort()).toEqual([AUTHOR, workspaceMate].sort());

    const person = await phone.livePersonChange(AUTHOR);
    expect(person?.person).toEqual({ pubkey: AUTHOR, kind: 'human', name: 'Author Two' });
    expect(person?.pushLevel).toBe('attention');
    expect([...person!.viewers].sort()).toEqual([AUTHOR, workspaceMate, roomMate].sort());
    // A viewer who shares no Workspace or Room with the person never hears it.
    expect(person!.viewers.has(outsider)).toBe(false);

    await scope1.database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [workspaceMate]);
    expect((await phone.livePersonChange(AUTHOR))!.viewers.has(workspaceMate)).toBe(false);
    expect((await phone.liveWorkspaceChange(WORKSPACE))!.viewers.has(workspaceMate)).toBe(false);
  });


  it('wakes push only after message and device writes commit', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const wake = vi.fn();
    listener.setPushWake(wake);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    expect(wake).not.toHaveBeenCalled();
    await scope1.database.transaction(async (db) => {
      await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
        VALUES('push-wake-device',$1,'ios','physical')`, [AUTHOR]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text)
        VALUES('push-wake-message',$1,$2,'hello')`, [ROOM, AUTHOR]);
      expect(wake).not.toHaveBeenCalled();
    });
    await eventually(() => wake.mock.calls.length === 2);
    await scope1.database.query(`INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
      VALUES($1,$2,now(),'push-wake-message')`, [ROOM, AUTHOR]);
    expect(wake).toHaveBeenCalledTimes(2);
  });


  it('wakes AI-client webhook delivery only when a tag commits', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const wake = vi.fn();
    listener.setMcpWebhookWake(wake);
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.transaction(async (db) => {
      await db.query(`SELECT pg_notify($1,$2)`, [POSTGRES_LIVE_CHANNEL,
        JSON.stringify({ table: MCP_WEBHOOK_TABLE, operation: 'INSERT', roomId: ROOM })]);
      expect(wake).not.toHaveBeenCalled();
    });
    await eventually(() => wake.mock.calls.length === 1);
  });


  it('fans out one committed helper release without a follow-up read', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    const query = vi.spyOn(scope1.database, 'query');
    await scope1.database.query(`INSERT INTO helper_release_notifications(singleton,version,sha)
      VALUES(true,'v0.0.128',$1)`, ['a'.repeat(40)]);
    await eventually(() => events.some((event) => event.type === 'helper-release'));
    expect(events.filter((event) => event.type === 'helper-release')).toEqual([{
      type: 'helper-release',
      version: 'v0.0.128', sha: 'a'.repeat(40),
    }]);
    expect(query).toHaveBeenCalledTimes(1);
  });


  it('delivers read-mark changes to the listener with the reader identity', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const events: LiveEvent[] = [];
    const release = live.subscribe(ROOM, (event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
       VALUES($1,$2,now(),$3)`,
      [ROOM, AUTHOR, 'a'.repeat(64)],
    );
    await eventually(() => events.some((event) =>
      event.type === 'invalidate' && event.reason === 'postgres:room_read_marks'));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invalidate', roomId: ROOM, readerId: AUTHOR,
    }));
    release();
    await listener.stop();
  });


  it('routes a bookmark change to its owner without broadcasting its content', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('saved-message',$1,$2,'private content')`, [ROOM, AUTHOR]);
    await scope1.database.query(`INSERT INTO message_bookmarks(
      identity_id,workspace_id,room_id,message_id,source_room_name,source_room_kind,
      message_created_at
    ) SELECT $1,$2,$3,id,'Room','room',created_at FROM messages WHERE id='saved-message'`,
    [AUTHOR, WORKSPACE, ROOM]);
    await eventually(() => events.some((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:message_bookmarks'));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'invalidate', roomId: '', reason: 'postgres:message_bookmarks',
      readerId: AUTHOR, workspaceId: WORKSPACE, messageId: 'saved-message',
    }));
    expect(client.payloads.find((payload) => payload.includes('message_bookmarks')))
      .not.toContain('private content');
  });


  it('coalesces a section clear into one Needs-you wake per Room', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const events: LiveEvent[] = [];
    live.subscribeAll((event) => events.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    await scope1.database.query(`INSERT INTO messages(id,room_id,author_id,text)
      VALUES('ask-one',$1,$2,'@author please review?'),
        ('ask-two',$1,$2,'@author please approve?')`, [ROOM, AUTHOR]);
    await scope1.database.transaction(async (db) => {
      await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at)
        VALUES($1,'ask-one',$2,now()),($1,'ask-two',$2,now())`, [AUTHOR, WORKSPACE]);
    });
    await eventually(() => events.some((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:needs_you_marks'));
    expect(events.filter((event) => event.type === 'invalidate' &&
      event.reason === 'postgres:needs_you_marks')).toEqual([
      expect.objectContaining({ roomId: '', readerId: AUTHOR, sourceRoomId: ROOM }),
    ]);
    expect(client.payloads.filter((payload) => payload.includes('needs_you_marks')))
      .toHaveLength(1);
  });


  it('projects every committed source without a batch cap', async () => {
    let releaseReads!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
    let active = 0;
    let peak = 0;
    let repositoryReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM rooms WHERE repository_key')) {
        active++;
        peak = Math.max(peak, active);
        await readBarrier;
        active--;
        repositoryReads++;
      }
      return { rows: [], rowCount: 0 };
    });
    const client = new EventEmitter() as EventEmitter & LivePgClient;
    let listening = false;
    client.connect = async () => undefined;
    client.query = async () => { listening = true; };
    client.end = async () => { client.emit('end'); };
    const live = new LiveHub();
    const listener = new PostgresLiveListener(
      { query, transaction: vi.fn() }, live, () => client,
    );
    scope1.listeners.push(listener);
    const running = listener.run();
    await eventually(() => listening);
    for (let index = 0; index < 15; index++)
      client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
        table: 'github_repositories', operation: 'UPDATE', roomId: ROOM,
        repositoryId: String(index),
      }) });
    expect(listener.projectionHealth()).toMatchObject({
      connected: true, active: 15, queued: 0, delivered: 0, failed: 0,
    });
    expect(listener.projectionHealth().oldestActiveAgeMs).not.toBeNull();
    expect(listener.projectionHealth().oldestQueuedAgeMs).toBeNull();
    client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
      table: 'github_repositories', operation: 'UPDATE', roomId: ROOM, repositoryId: '5',
    }) });
    expect(listener.projectionHealth().queued).toBe(0);
    releaseReads();
    await eventually(() => repositoryReads === 16);
    expect(peak).toBe(16);
    expect(listener.projectionHealth()).toMatchObject({
      active: 0, queued: 0, dropped: 0, delivered: 16, failed: 0,
      oldestActiveAgeMs: null, oldestQueuedAgeMs: null,
    });
    const health = listener.projectionHealth();
    expect(health.lastNotificationAt).not.toBeNull();
    expect(health.lastDeliveredAt).toBeGreaterThanOrEqual(health.lastNotificationAt!);
    expect(health.lastDeliveryAgeMs).not.toBeNull();
    expect(listener.projectionHealth().deliveryAgeBuckets.reduce((sum, count) => sum + count, 0))
      .toBe(16);
    await listener.stop();
    await running;
    expect(listener.projectionHealth().connected).toBe(false);
  });


  it('delivers every committed notification without a cap or backlog rescan', async () => {
    let releaseReads!: () => void;
    const readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM rooms WHERE repository_key')) await readBarrier;
      return { rows: [], rowCount: 0 };
    });
    const client = new EventEmitter() as EventEmitter & LivePgClient;
    let listening = false;
    client.connect = async () => undefined;
    client.query = async () => { listening = true; };
    client.end = async () => { client.emit('end'); };
    const live = new LiveHub();
    const resync = vi.fn();
    live.subscribeResync(resync);
    const listener = new PostgresLiveListener(
      { query, transaction: vi.fn() }, live, () => client,
    );
    scope1.listeners.push(listener);
    const running = listener.run();
    await eventually(() => listening && resync.mock.calls.length === 1);
    resync.mockClear();
    for (let index = 0; index < 520; index++)
      client.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload: JSON.stringify({
        table: 'github_repositories', operation: 'UPDATE', roomId: ROOM,
        repositoryId: String(index),
      }) });
    expect(listener.projectionHealth()).toMatchObject({
      active: 520, queued: 0, dropped: 0, resyncPending: false,
    });
    releaseReads();
    await eventually(() => listener.projectionHealth().active === 0 &&
      listener.projectionHealth().queued === 0);
    expect(resync).not.toHaveBeenCalled();
    await listener.stop();
    await running;
  });


  it('fans a committed write from server A to a subscriber on server B', async () => {
    const liveA = new LiveHub();
    const liveB = new LiveHub();
    const clientsA: PgliteListenClient[] = [];
    const clientsB: PgliteListenClient[] = [];
    const listenerA = new PostgresLiveListener(
      scope1.database,
      liveA,
      () => {
        const client = new PgliteListenClient(scope1.database);
        clientsA.push(client);
        return client;
      },
    );
    const listenerB = new PostgresLiveListener(
      scope1.database,
      liveB,
      () => {
        const client = new PgliteListenClient(scope1.database);
        clientsB.push(client);
        return client;
      },
    );
    scope1.listeners.push(listenerA, listenerB);
    void listenerA.run();
    void listenerB.run();
    await eventually(() => clientsA.length === 1 && clientsB.length === 1);

    const received: LiveEvent[] = [];
    liveB.subscribe(ROOM, (event) => received.push(event));
    // Every successful LISTEN (including its first) now resyncs to recover a
    // delivery written before the listener was ready. Let that connection
    // establishment event settle before verifying the next committed write.
    await eventually(() =>
      received.some((event) => event.type === 'invalidate' && event.reason === 'resync'),
    );
    received.length = 0;
    await scope1.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`,
        ['1'.repeat(64), ROOM, AUTHOR],
      );
      expect(received).toEqual([]);
    });

    await eventually(() => received.length === 1);
    expect(received).toEqual([
      expect.objectContaining({
        type: 'invalidate',
        roomId: ROOM,
        agentId: AUTHOR,
        messageId: '1'.repeat(64),
      }),
    ]);
    expect(clientsB[0]!.payloads).toHaveLength(1);
    expect(JSON.parse(clientsB[0]!.payloads[0]!)).toEqual(
      expect.objectContaining({
        table: 'messages',
        operation: 'INSERT',
        roomId: ROOM,
        messageId: '1'.repeat(64),
        agentId: AUTHOR,
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        databaseAt: expect.any(Number),
      }),
    );
    expect(received[0]).toEqual(
      expect.objectContaining({
        trace: expect.objectContaining({
          id: expect.stringMatching(/^[0-9a-f]{32}$/),
          databaseAt: expect.any(Number),
          emittedAt: expect.any(Number),
        }),
      }),
    );
    expect(clientsB[0]!.payloads[0]).not.toContain('hello');
  });


  it('publishes room-scoped message and turn notifications without a database lookup', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const query = vi.fn(scope1.database.query.bind(scope1.database));
    const listener = new PostgresLiveListener(
      { query, transaction: scope1.database.transaction.bind(scope1.database) },
      live,
      () => client,
    );
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribe(ROOM, (event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;
    query.mockClear();

    for (const table of ['messages', 'agent_turns']) {
      client.emit('notification', {
        channel: POSTGRES_LIVE_CHANNEL,
        payload: JSON.stringify({
          table,
          operation: table === 'messages' ? 'INSERT' : 'UPDATE',
          roomId: ROOM,
          agentId: AUTHOR,
          ...(table === 'messages' ? { messageId: 'message-id' } : { requestId: 'request-id' }),
        }),
      });
    }

    await eventually(() => received.length === 2);
    expect(query).not.toHaveBeenCalled();
    expect(received.map((event) => event.type === 'invalidate' && event.reason)).toEqual([
      'postgres:messages',
      'postgres:agent_turns',
    ]);
    expect(received).toEqual([
      expect.objectContaining({ messageId: 'message-id' }),
      expect.objectContaining({ requestId: 'request-id' }),
    ]);
  });


  it('relays a newer helper connection epoch to every other server instance', async () => {
    const agent = 'f'.repeat(64);
    await scope1.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bee')`, [agent]);
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    // Server A accepts the connection against its own hub; B learns through PostgreSQL.
    const epoch = await claimAgentConnection(scope1.database, new LiveHub(), agent, { lifecycleId: 'life' }, {
      connectionId: 'connection-a', instanceId: 'server-a',
    });
    await eventually(() => received.some((event) => event.type === 'agent-connection'));
    expect(received.filter((event) => event.type === 'agent-connection')).toEqual([
      { type: 'agent-connection', roomId: '', agentId: agent, epoch },
    ]);
  });


  it('delivers a membership change as an agent-directed invalidation', async () => {
    const live = new LiveHub();
    const client = new PgliteListenClient(scope1.database);
    const listener = new PostgresLiveListener(scope1.database, live, () => client);
    scope1.listeners.push(listener);
    const received: LiveEvent[] = [];
    live.subscribeAll((event) => received.push(event));
    void listener.run();
    await eventually(() => listener.projectionHealth().connected);
    received.length = 0;

    const freshRoom = '99999999-9999-4999-8999-999999999999';
    await scope1.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'milo')`,
      [freshRoom, WORKSPACE, AUTHOR],
    );
    await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, freshRoom, AUTHOR],
    );

    await eventually(() =>
      received.some(
        (event) =>
          event.type === 'invalidate' &&
          event.reason === 'postgres:memberships' &&
          event.targetAgentId === AUTHOR &&
          event.roomId === freshRoom,
      ),
    );
  });
});
