import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalUsageAccountSnapshot } from '@beeline/api-contract/helper-usage';
import type { AgentUsage } from '@beeline/api-contract/daemon';
import { publishUsageAccount, readAgentUsageCell } from './helper-usage.js';
import { postRoomChoice } from './room-choice.js';
import { SurfaceResponseCache, isWorkspaceView } from '@beeline/buzz-client';
let SurfaceRegistry: typeof import('../../mobile/sources/buzz/surface-registry.js').SurfaceRegistry;
let shouldReadWorkspaceRoster: typeof import('../../mobile/sources/buzz/room-participants.js').shouldReadWorkspaceRoster;
import { groupAFixture, ObservedDatabase, reader, peer, workspace, room } from '../proofs/router-group-a-postgres.js';
import {createWallet,readWalletView,fakeCdpWalletSource} from './wallet.js';
import {PhoneService} from './phone-service.js';
import {buildOwnerSnapshot,fenceOwnerProjection} from './router-owner-projections.js';
import {fenceRouterEnqueue} from './router-projections.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.skipIf(!url)('P3/P5 Group A phone read closure', () => {
  let fixture: Awaited<ReturnType<typeof groupAFixture>>;
  // A cold full migration is setup, independently of each 20s proof budget.
  beforeAll(async () => {
    // The server-only CI install has no Expo toolchain. Load the actual pure
    // phone consumers only when this opt-in PostgreSQL proof will execute.
    ({SurfaceRegistry} = await import('../../mobile/sources/buzz/surface-registry.js'));
    ({shouldReadWorkspaceRoster} = await import('../../mobile/sources/buzz/room-participants.js'));
    fixture = await groupAFixture(url!);
  }, 120_000);
  afterEach(async () => { await fixture?.closeServers(); });
  afterAll(async () => { await fixture?.close(); });

  it('F03: unrelated messages read no roster and a committed membership automatically rebases active search windows',async()=>{
    const server=await fixture.server(fixture.a,['workspace-roster']);
    const head={family:'workspace-roster' as const,workspaceId:workspace(10)};
    await server.demand(head);
    const value=server.lanes.peek(head).value as import('@beeline/api-contract/router-protocol').RouterValues['workspace-roster'];
    const search={...head,query:{revision:value.revision,q:'Reader'}};
    await server.demand(search);
    expect(server.lanes.peek(search).value).toMatchObject({revision:value.revision,members:[{identity:{pubkey:reader}}]});
    const sealed=await server.protocol.snapshot(search);
    const reads=server.reads();server.builds.length=0;
    await fixture.b.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Unrelated message')`,['3b'.repeat(32),room(10),peer]);
    await server.barrier();expect(server.builds).toEqual([]);expect(server.reads()).toBe(reads);
    expect(server.lanes.peek(search).state).toBe('LIVE');
    await fixture.b.query(`UPDATE memberships SET role='spectator' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,[workspace(10),peer]);
    await server.barrier();
    await server.wait(()=>[head,search].every(input=>server.lanes.peek(input).state==='LIVE'&&
      (server.lanes.peek(input).value as typeof value|null)?.revision!==value.revision));
    const current=server.lanes.peek(head).value as typeof value;
    expect(server.lanes.peek(search)).toMatchObject({state:'LIVE',value:{revision:current.revision,members:[{identity:{pubkey:reader}}]}});
    expect(current.members.find(member=>member.identity.pubkey===peer)?.role).toBe('spectator');
    expect(server.reads()).toBeGreaterThan(reads);
    await expect(server.protocol.snapshot(search)).resolves.toMatchObject({value:{revision:current.revision}});
    const enqueue=vi.fn(()=>undefined);
    await expect(fenceRouterEnqueue(fixture.a,search,reader,
      sealed.authority,enqueue)).rejects.toThrow('authority');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('F08: owner snapshots write/provider/queue zero, survive Workspace removal and keep connector commits independent of wallet reads',async()=>{
    const source=fakeCdpWalletSource(),created=await createWallet(fixture.a,reader,workspace(7),source);
    source.state.holdings.set(created.address,new Map([['usdc',123],['eth',0]]));
    const observedWallet=await readWalletView(fixture.a,reader,workspace(7),source);
    const connector='77777777-7777-4777-8777-777777777777',agent='7e'.repeat(32);
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Owner helper')`,[agent]);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,reader]);
    await fixture.a.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,helper_agent_id,connector_type,status)
      VALUES($1,$2,$3,$4,'tailscale','connected')`,[connector,workspace(7),reader,agent]);
    await fixture.a.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NULL`,[reader]);
    const fetch=vi.fn(async()=>{throw new Error('Projection attempted provider work');});vi.stubGlobal('fetch',fetch);
    try{
      const server=await fixture.server(fixture.a,['owner-workbench','owner-wallet']);
      const workbench={family:'owner-workbench' as const},wallet={family:'owner-wallet' as const};
      server.observed.reset();await Promise.all([server.demand(workbench),server.demand(workbench)]);
      expect(server.reads()).toBe(1);
      expect(server.observed.statements.filter(({sql})=>/wallet_bindings|owner_wallet_projections|squire_work_queue/.test(sql))).toEqual([]);
      await server.demand(wallet);
      expect(server.lanes.peek(wallet).value).toMatchObject({wallet:observedWallet});
      expect(server.lanes.peek(workbench).cut?.stream).toBe(`owner:${reader}`);
      expect(server.lanes.peek(wallet).cut?.stream).toBe(`owner:${reader}`);
      expect(server.observed.statements.filter(({sql})=>/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql))).toEqual([]);
      server.observed.reset();server.builds.length=0;const reads=server.reads();
      await fixture.b.query(`UPDATE workspace_connectors SET signed_in_as='owner-committed@example.invalid' WHERE id=$1`,[connector]);
      await server.barrier();
      expect((server.lanes.peek(workbench).value as any).connectors.find((row:any)=>row.id==='tailscale'))
        .toMatchObject({signedInAs:'owner-committed@example.invalid'});
      expect(server.lanes.peek(wallet).state).toBe('LIVE');expect(server.reads()).toBe(reads);
      expect(server.builds).toEqual([workbench]);
      expect(server.observed.statements.filter(({sql})=>/wallet_bindings|owner_wallet_projections|squire_work_queue/.test(sql))).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();
      await fixture.a.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id IS NULL`,[reader]);}
  });

  it('F08: ownership transfer between build and enqueue fences the former owner private Workbench and gives only the new owner its row',async()=>{
    const agent='7f'.repeat(32),connector='77777777-7777-4777-8777-777777777778';
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Transfer helper')`,[agent]);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,reader]);
    await fixture.a.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,helper_agent_id,connector_type,status,signed_in_as)
      VALUES($1,$2,$3,$4,'tailscale','connected','private-old-owner')`,[connector,workspace(7),reader,agent]);
    const phone=new PhoneService(fixture.a,'https://synthetic.invalid'),input={family:'owner-workbench' as const};
    const stale=await fixture.a.transaction(async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return buildOwnerSnapshot(db,phone,input,reader);
    });
    await fixture.b.query(`UPDATE workspace_connectors SET owner_identity_id=$2 WHERE id=$1`,[connector,peer]);
    const enqueue=vi.fn(()=>undefined);
    await expect(fenceOwnerProjection(fixture.a,input,reader,stale.authority,enqueue)).rejects.toThrow('authority');
    expect(enqueue).not.toHaveBeenCalled();
    const old=await phone.readRouterSnapshot(input,reader),current=await phone.readRouterSnapshot(input,peer);
    expect(JSON.stringify(old.value)).not.toContain('private-old-owner');
    expect((current.value as any).connectors.find((row:any)=>row.id==='tailscale')).toMatchObject({signedInAs:'private-old-owner'});
  });

  it('F09: a delayed profile cannot enqueue private grants after owner transfer or Workspace revocation on another pool',async()=>{
    const agent='6e'.repeat(32),input={family:'agent-profile' as const,workspaceId:workspace(6),agentId:agent};
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Private profile helper')`,[agent]);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,reader]);
    await fixture.a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,[workspace(6),agent]);
    await fixture.a.query(`INSERT INTO agent_grants(id,workspace_id,agent_id,kind,target,reason,status,requested_by,decided_by,room_id)
      VALUES('66666666-6666-4666-8666-666666666666',$1,$2,'secret','private-owner-grant','isolated proof','approved',$3,$3,$4)`,[workspace(6),agent,reader,room(6)]);
    const phone=new PhoneService(fixture.a,'https://synthetic.invalid'),stale=await phone.readRouterSnapshot(input,reader);
    expect(JSON.stringify(stale.value)).toContain('private-owner-grant');
    await fixture.b.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1',[agent,peer]);
    const enqueue=vi.fn(()=>undefined);
    await expect(fenceRouterEnqueue(fixture.a,input,reader,stale.authority,enqueue)).rejects.toThrow('authority');
    expect(enqueue).not.toHaveBeenCalled();expect(JSON.stringify((await phone.readRouterSnapshot(input,reader)).value)).not.toContain('private-owner-grant');
    const transferred=await phone.readRouterSnapshot(input,peer);expect(JSON.stringify(transferred.value)).toContain('private-owner-grant');
    await fixture.b.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,[workspace(6),peer]);
    try{
      await expect(fenceRouterEnqueue(fixture.a,input,peer,transferred.authority,enqueue)).rejects.toThrow('authority');
      expect(enqueue).not.toHaveBeenCalled();
    }finally{await fixture.a.query(`UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,[workspace(6),peer]);}
  });

  it('F02: one affected list update on both independent PostgreSQL listeners, with no unrelated projection or phone read', async () => {
    const left = await fixture.server(fixture.a, ['room-list', 'needs-you-count']);
    const right = await fixture.server(fixture.b, ['room-list', 'needs-you-count']);
    const list = { family: 'room-list' as const, workspaceId: workspace() };
    await left.demand(list); await right.demand(list);
    const reads = [left.reads(), right.reads()];
    const positions = [left.frames.length, right.frames.length];
    left.observed.reset(); right.observed.reset(); left.builds.length = 0; right.builds.length = 0;
    await fixture.a.query(`UPDATE workspaces SET name='Committed name' WHERE id=$1`, [workspace()]);
    await Promise.all([left, right].map(server => server.wait(() => server.frames.slice(positions[server === left ? 0 : 1]).some(frame => frame.kind === 'push-commit'))));
    await Promise.all([left.applied(), right.applied()]);
    for (const [i, server] of [left, right].entries()) {
      const facts = server.frames.slice(positions[i]).filter(frame => frame.kind === 'push-part').flatMap(frame => frame.facts);
      expect(facts.filter(fact => fact.payload.kind === 'scope-replace')).toHaveLength(1);
      expect(facts.find(fact => fact.payload.kind === 'scope-replace').payload).toMatchObject({ family: 'room-list', scope: workspace() });
      expect(server.reads()).toBe(reads[i]);
      expect(server.builds).toEqual([list]);
      expect(server.observed.statements.filter(statement => /FROM candidates WHERE|SELECT counted\.\*/.test(statement.sql))).toEqual([]);
      expect(server.lanes.peek(list).value).toEqual(await server.phone.buildRouterValue(fixture.a, list, reader));
    }
  });

  it('F06: ten Workspace badges stay under 1 KiB and one changed Workspace never rebuilds another badge or the full Tray', async () => {
    const server = await fixture.server(fixture.a, ['needs-you-count']);
    for (let n = 1; n <= 10; n++) {
      const input = { family: 'needs-you-count' as const, workspaceId: workspace(n) };
      const snapshot = await server.protocol.snapshot(input);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1024);
      await server.demand(input);
    }
    server.observed.reset(); server.builds.length = 0; const position = server.frames.length, reads = server.reads();
    await fixture.b.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('group-a-badge',$1,$2,'@reader please review')`, [room(2), peer]);
    await server.wait(() => server.frames.slice(position).some(frame => frame.kind === 'push-commit'));
    await server.applied();
    const facts = server.frames.slice(position).filter(frame => frame.kind === 'push-part').flatMap(frame => frame.facts);
    const changed = facts.filter(fact => fact.payload.kind === 'scope-replace');
    expect(changed).toHaveLength(1);
    expect(changed[0].payload).toEqual({ kind: 'scope-replace', family: 'needs-you-count', scope: workspace(2), value: { count: 1 } });
    expect(server.reads()).toBe(reads);
    expect(server.builds).toEqual([{ family: 'needs-you-count', workspaceId: workspace(2) }]);
    expect(server.observed.statements.flatMap(statement => statement.rows ?? [])
      .filter(row => typeof row.workspace_id === 'string' && row.workspace_id !== workspace(2))).toEqual([]);
    for (const statement of server.observed.statements)
      for (const n of [1, 3, 4, 5, 6, 7, 8, 9, 10]) expect(statement.args).not.toContain(workspace(n));
  });

  it('F04 purity/seen: snapshots write nothing, count and cells share the cut, and only submitted painted IDs start clocks once', async () => {
    const server = await fixture.server(fixture.a, ['needs-you', 'needs-you-count']);
    const ids = ['c'.repeat(64), 'd'.repeat(64)] as const;
    await fixture.b.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$3,$4,'@reader please review first'),($2,$3,$4,'@reader please review second')`, [...ids, room(3), peer]);
    const input = { family: 'needs-you' as const, workspaceId: workspace(3) };
    server.observed.reset();
    const cells = await server.protocol.snapshot(input), count = await server.protocol.snapshot({ ...input, family: 'needs-you-count' });
    expect(cells.value).toMatchObject({ count: 2, items: expect.arrayContaining(ids.map(messageId => expect.objectContaining({ messageId }))) });
    expect(count.value).toEqual({ count: 2 }); expect(count.cut).toEqual(cells.cut);
    expect(server.observed.statements.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql))).toEqual([]);
    expect((await fixture.a.query(`SELECT * FROM needs_you_marks WHERE message_id=ANY($1)`, [ids])).rows).toEqual([]);
    const args = { workspaceId: workspace(3), messageIds: [ids[0]] }, command = { v: 1 as const, id: 'group-a-painted' };
    const first = await server.request('markNeedsYouSeen', args, command);
    expect(await server.request('markNeedsYouSeen', args, command)).toEqual(first);
    const marks = (await fixture.a.query(`SELECT message_id,first_seen_at FROM needs_you_marks WHERE message_id=ANY($1)`, [ids])).rows;
    expect(marks).toHaveLength(1); expect(marks[0]!.message_id).toBe(ids[0]);
    await server.protocol.snapshot(input);
    expect((await fixture.a.query(`SELECT message_id,first_seen_at FROM needs_you_marks WHERE message_id=ANY($1)`, [ids])).rows).toEqual(marks);
  });

  it('F20: two machines publish one account revision once and both phones receive the small cell without profile/Workbench reads', async () => {
    const agents = ['e'.repeat(64), 'f'.repeat(64)];
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','First helper'),($2,'agent','Second helper')`, agents);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$3,'first-machine'),($2,$3,'second-machine')`, [...agents, reader]);
    await fixture.a.query(`INSERT INTO agent_connections(agent_id,connection_id,epoch,instance_id) VALUES($1,'first-source',1,'group-a'),($2,'second-source',1,'group-a')`, agents);
    const before = Date.now() / 1000 - 10;
    const usage: AgentUsage = { updatedAt: before, windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: .2, updatedAt: before }],
      read: { status: 'fresh', at: before }, account: { provider: 'claude', key: `id:${'c'.repeat(32)}` } };
    const publication = (value: AgentUsage, index: number) => ({ ownerId: reader, usage: value,
      revision: createHash('sha256').update(canonicalUsageAccountSnapshot(value, reader)).digest('hex'),
      source: { connectionId: index === 0 ? 'first-source' : 'second-source', epoch: 1 } });
    for (const [index, agent] of agents.entries()) await fixture.a.query(`UPDATE agents SET usage_snapshot=$2::jsonb WHERE agent_id=$1`,
      [agent, JSON.stringify({ updatedAt: before, windows: [], context: { used: (index + 1) * 100, size: 1000 } })]);
    for (const [index, agent] of agents.entries()) await publishUsageAccount(fixture.a, agent, publication(usage, index));
    const cells = await Promise.all(agents.map(agent => readAgentUsageCell(fixture.a, agent, reader)));
    // Enable only this isolated process's fixture negotiation; the deployment
    // default and repository capability stay disabled.
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', '1');
    try {
      const left = await fixture.server(fixture.a, [], true), right = await fixture.server(fixture.b, [], true);
      expect(left.frames.at(-1)).toMatchObject({ usageCellV1: true });
      const positions = [left.frames.length, right.frames.length];
      const at = before + 1, current: AgentUsage = { ...usage, updatedAt: at, read: { status: 'fresh', at },
        windows: [{ ...usage.windows[0]!, utilization: .4, updatedAt: at }] };
      const a = new ObservedDatabase(fixture.a), b = new ObservedDatabase(fixture.b);
      const results = await Promise.all(agents.map((agent, index) => publishUsageAccount(index ? b : a, agent, publication(current, index))));
      expect(results[0]).toEqual(results[1]);
      expect([...a.statements, ...b.statements].filter(({ sql }) => /^UPDATE usage_accounts SET/.test(sql))).toHaveLength(1);
      for (const [index, server] of [left, right].entries()) {
        await server.wait(() => server.frames.slice(positions[index]).filter(frame => frame.kind === 'usage-cell').length === 2);
        const received = server.frames.slice(positions[index]).filter(frame => frame.kind === 'usage-cell').map(frame => frame.cell);
        expect(received.map(cell => cell.agentId).sort()).toEqual([...agents].sort());
        for (const cell of received) {
          expect(cell.revision).toBe(cells.find(previous => previous.agentId === cell.agentId)!.revision + 1);
          expect(cell.usage.windows[0].utilization).toBe(.4);
          expect(cell.usage.context).toEqual({ used: (agents.indexOf(cell.agentId) + 1) * 100, size: 1000 });
          expect(Buffer.byteLength(JSON.stringify(cell))).toBeLessThanOrEqual(32 * 1024);
        }
        expect(server.requests).toEqual([]);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('F24: send/reaction/delete/decision replay once on the other server, update the other reader without a read and retain legacy hints', async () => {
    const writer = await fixture.server(fixture.a, ['room-head']);
    const observer = await fixture.server(fixture.b, ['room-head'], false, peer);
    const replay = await fixture.server(fixture.b, []);
    const input = { family: 'room-head' as const, workspaceId: workspace(4), roomId: room(4) };
    await observer.demand(input);
    const readCount = observer.reads(), messageId = '1'.repeat(64);
    const hints: unknown[] = [], stopHints = writer.live.subscribeAll(event => { if (event.type === 'invalidate' && event.reason === 'phone-write') hints.push(event); });
    const state = () => observer.lanes.peek(input).value as any;
    try {
      const send = { roomId: room(4), messageId, text: 'Group A committed message' }, identity = { v: 1 as const, id: messageId };
      const receipt = await writer.request('sendRoomMessage', send, identity);
      expect(await replay.request('sendRoomMessage', send, identity)).toEqual(receipt);
      await observer.wait(() => state()?.messages.some((message: any) => message.id === messageId));
      expect((await fixture.a.query('SELECT id FROM messages WHERE id=$1', [messageId])).rows).toHaveLength(1);

      const reaction = { roomId: room(4), messageId, emoji: '👍' as const }, react = { v: 1 as const, id: 'group-a-react' };
      const reacted = await writer.request('reactToMessage', reaction, react);
      expect(await replay.request('reactToMessage', reaction, react)).toEqual(reacted);
      await observer.wait(() => JSON.stringify(state()?.messages.find((message: any) => message.id === messageId)?.reactions)?.includes(reader) === true);
      expect((await fixture.a.query('SELECT reactions FROM messages WHERE id=$1', [messageId])).rows[0]!.reactions).toEqual({ '👍': [reader] });

      const deletion = { roomId: room(4), messageId }, remove = { v: 1 as const, id: 'group-a-delete' };
      const deleted = await writer.request('deleteRoomMessage', deletion, remove);
      expect(await replay.request('deleteRoomMessage', deletion, remove)).toEqual(deleted);
      await observer.wait(() => !state()?.messages.some((message: any) => message.id === messageId && message.text === send.text));
      const agent = '2'.repeat(64);
      await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Decision helper')`, [agent]);
      await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, reader]);
      await fixture.a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace(4), room(4), agent]);
      const choice = await fixture.a.transaction(tx => postRoomChoice(tx, { roomId: room(4), agentId: agent, mode: 'question', prompt: 'Group A choice?',
        options: [{ label: 'One', consequence: 'Use one' }, { label: 'Two', consequence: 'Use two' }], ttlSeconds: 300 }));
      await observer.wait(() => JSON.stringify(state()).includes(choice.choiceId));
      const skip = { choiceId: choice.choiceId }, decide = { v: 1 as const, id: 'group-a-decision' };
      const decided = await writer.request('skipChoice', skip, decide);
      expect(await replay.request('skipChoice', skip, decide)).toEqual(decided);
      await observer.wait(() => JSON.stringify(state()).includes('skipped'));
      expect((await fixture.a.query('SELECT status FROM room_choices WHERE id=$1', [choice.choiceId])).rows).toEqual([{ status: 'skipped' }]);
      expect(observer.reads()).toBe(readCount);
      expect(observer.requests.filter(request => request.op.startsWith('read'))).toHaveLength(1);
      expect(hints).toEqual(expect.arrayContaining([expect.objectContaining({ messageId, reason: 'phone-write' })]));
      expect((await fixture.a.query('SELECT operation,count(*)::int n FROM router_commands WHERE command_id=ANY($1) GROUP BY operation', [[identity.id, react.id, remove.id, decide.id]])).rows)
        .toHaveLength(4);
    } finally { stopHints(); }
  });

  it('F25: the closed picker reads no Workspace, concurrent opens share one snapshot, and a stale held roster cannot authorize a membership write', async () => {
    const server = await fixture.server(fixture.a, []), candidate = '3'.repeat(64);
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Addable person')`, [candidate]);
    await fixture.a.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [workspace(7), candidate]);
    const storage = new Map<string, string>();
    const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async key => storage.get(key) ?? null,
      set: async (key, value) => { storage.set(key, value); }, remove: async key => { storage.delete(key); } }));
    const address = { relayOrigin: 'https://synthetic.invalid', viewerPubkey: reader, endpoint: '/workspace/:id', params: { workspaceId: workspace(7) } };
    // This is the actual gate and shared cache used by _chat-surface's picker
    // effect; transport requests below cross the real server socket boundary.
    const picker = (visible: boolean) => shouldReadWorkspaceRoster({ activeWorkspaceId: workspace(7), rosterSurfaceVisible: visible })
      ? cache.fetch(address, isWorkspaceView, () => server.request('readWorkspace', { workspaceId: workspace(7) })) : Promise.resolve(null);
    for (let n = 0; n < 1000; n++) await picker(false);
    expect(server.requests).toEqual([]);
    const [first, second] = await Promise.all([picker(true), picker(true)]);
    expect(first).toEqual(second); expect(server.requests).toHaveLength(1);
    expect(first?.members.some(member => member.identity.pubkey === candidate)).toBe(true);
    expect(first?.viewer.permissions.manage).toBe(true);
    await fixture.b.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`, [workspace(7), reader]);
    expect(cache.peek(address, isWorkspaceView)?.viewer.permissions.manage).toBe(true);
    await expect(server.request('addRoomMember', { roomId: room(7), memberId: candidate })).rejects.toThrow();
    expect((await fixture.a.query('SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL', [room(7), candidate])).rows).toEqual([]);
    expect(server.requests.filter(request => request.op.startsWith('read'))).toHaveLength(1);
  });

  it('F05 schedule slice: sixteen released Room lanes perform zero reads on changes and return with at most one read per key', async () => {
    const server = await fixture.server(fixture.a, ['room-scheduled-work']);
    const inputs = Array.from({ length: 16 }, (_, n) => ({ family: 'room-scheduled-work' as const, roomId: room(n + 1) }));
    const releases = [];
    // Workspace 7's picker test deliberately revoked the reader. Restore it
    // through the real membership source before opening these authorized lanes.
    await fixture.a.query(`UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND identity_id=$2`, [workspace(7), reader]);
    await server.barrier();
    for (const input of inputs) releases.push(await server.demand(input));
    for (const release of releases) release();
    const before = server.reads();
    await fixture.b.query(`UPDATE rooms SET name=name||' changed' WHERE id=ANY($1::uuid[])`, [inputs.map(input => input.roomId)]);
    await server.barrier(); expect(server.reads()).toBe(before);
    for (const input of inputs) { const reads = server.reads(); await server.demand(input); expect(server.reads() - reads).toBeLessThanOrEqual(1); }
    expect(server.requests.filter(request => request.op === 'readRouterSnapshot')).toHaveLength(server.reads());
  });
});
