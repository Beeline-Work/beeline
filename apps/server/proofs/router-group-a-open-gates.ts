import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import { groupAFixture, peer, reader, room, workspace } from './router-group-a-postgres.js';
import { createAgentCommand } from '../src/agent-command.js';
import { saveWorkflow, startWorkflow } from '../src/workflow-runs.js';
import { SurfaceResponseCache, isAgentDetailView } from '@beeline/buzz-client';
import { SurfaceRegistry } from '../../mobile/sources/buzz/surface-registry.js';
import {projectWorkbenchDisplay} from '@beeline/api-contract/workbench';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (!url) throw new Error('Closure gates require BEELINE_COMMAND_TEST_POSTGRES_URL; refusing to skip PostgreSQL proof');

describe('Group A unclosed executable obligations', () => {
  let fixture: Awaited<ReturnType<typeof groupAFixture>>;
  beforeAll(async () => { fixture = await groupAFixture(url); }, 120_000);
  afterEach(async () => { await fixture?.closeServers(); });
  afterAll(async () => { await fixture?.close(); });
  const replacements = (frames: Record<string, any>[], position: number) => frames.slice(position)
    .filter(frame => frame.kind === 'push-part').flatMap(frame => frame.facts)
    .filter(fact => fact.payload.kind === 'scope-replace').map(fact => fact.payload.value);

  it('F03: 1,000 transient frames cause no reads and a committed membership supplies the exact roster fact without a read', async () => {
    const server = await fixture.server(fixture.a, ROUTER_FAMILIES);
    const initial = await server.request('readWorkspace', { workspaceId: workspace(8) });
    expect(initial.members.find(member => member.identity.pubkey === peer)!.role).toBe('owner');
    for (let n = 0; n < 1000; n++) for (const type of ['draft', 'thought', 'presence'] as const) {
      // Real transport envelopes exercise the existing server fanout path;
      // these non-durable frames cannot authorize another baseline read.
      if (type === 'presence') server.live.publish({ type, roomId: room(8), agentId: peer, status: 'online', observedAt: 1 });
      else server.live.publish({ type, roomId: room(8), agentId: peer, turnId: 'synthetic-turn', text: 'transient' });
    }
    await server.barrier(); expect(server.requests).toHaveLength(1);
    const position = server.frames.length;
    await fixture.b.query(`UPDATE memberships SET role='spectator' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [workspace(8), peer]);
    await server.barrier();
    const expected = await server.phone.readWorkspace(workspace(8), reader);
    expect(expected!.members.find(member => member.identity.pubkey === peer)!.role).toBe('spectator');
    expect(server.requests).toHaveLength(1);
    const rosterFacts = replacements(server.frames, position).filter(value => Array.isArray(value.members) && value.workspace?.id === workspace(8));
    expect(rosterFacts, 'F03 committed membership must supply one exact authorized roster DTO').toEqual([{...expected,revision:(await fixture.a.query<{epoch:string}>(`SELECT epoch::text FROM router_authority WHERE scope=$1`,[`roster:${workspace(8)}`])).rows[0]!.epoch}]);
  });

  it('F04: one changed Room never rereads cells from an unaffected Room', async () => {
    const ids = ['5'.repeat(64), '6'.repeat(64)];
    await fixture.a.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$3,$5,'@reader please review changed'),($2,$4,$5,'@reader please review untouched')`,
      [...ids, room(), room(11), peer]);
    const server = await fixture.server(fixture.a, ['needs-you', 'needs-you-count']);
    const cells={family:'needs-you' as const,workspaceId:workspace()},badge={family:'needs-you-count' as const,workspaceId:workspace()};
    await server.demand(cells);await server.demand(badge);
    await server.barrier(); server.observed.reset();
    await fixture.b.query(`UPDATE messages SET text='@reader please review committed edit' WHERE id=$1`, [ids[0]]);
    await server.barrier();
    const unrelatedCells = server.observed.statements.flatMap(statement => statement.rows ?? [])
      .filter(row => row.message_id === ids[1]);
    expect(unrelatedCells.map(row => row.message_id), 'F04 affected-Room emission must perform zero unaffected cell reads').toEqual([]);
    expect(server.lanes.peek(cells).state).toBe('LIVE');
    expect(server.lanes.peek(cells).value).toMatchObject({items:expect.arrayContaining([
      expect.objectContaining({messageId:ids[0],text:expect.stringContaining('committed edit')}),
      expect.objectContaining({messageId:ids[1]})])});
    expect(server.lanes.peek(badge).cut).toEqual(server.lanes.peek(cells).cut);
  });

  it('F05: a committed saved-workflow start supplies the exact held workflow list without a covering read', async () => {
    const agent = '9'.repeat(64), source = 'a9'.repeat(32);
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Workflow helper')`, [agent]);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, reader]);
    await fixture.a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace(9), room(9), agent]);
    await fixture.a.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Save and run the isolated proof workflow')`, [source, room(9), reader]);
    const command = await createAgentCommand(fixture.a, { roomId: room(9), agentId: agent, sourceMessageId: source, reason: 'test' });
    if (!command) throw new Error('Missing isolated workflow command');
    await saveWorkflow(fixture.a, command, { contract: {
      version: 1, name: 'group-a-proof', description: 'Review an isolated synthetic fixture', summary: 'Review a fixture', roles: ['worker'], start: 'work',
      handoffs: { work: { role: 'worker', does: 'Review this fixture.', requires: ['summary'], on: { done: 'done', timeout: 'failed' }, timeoutSeconds: 86400 },
        done: { kind: 'terminal', status: 'done', does: 'Finish the fixture.' }, failed: { kind: 'terminal', status: 'failed', does: 'End the fixture.' } },
    } });
    const server = await fixture.server(fixture.a, ROUTER_FAMILIES);
    expect(await server.request('listRoomWorkflowRuns', { roomId: room(9) })).toEqual({ workflows: [] });
    await server.barrier(); const position = server.frames.length;
    const started = await startWorkflow(fixture.b, command, { name: 'group-a-proof', roleBindings: { worker: agent } });
    await server.barrier();
    const expected = await server.phone.execute('listRoomWorkflowRuns', { roomId: room(9) }, reader);
    expect(expected.workflows.some(run => run.runId === started.runId)).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(replacements(server.frames, position).filter(value => Array.isArray(value.workflows)),
      'F05 saved-workflow changes must supply the exact list to the held workflow owner').toEqual([expected]);
  });

  it('F08: connector commit supplies one Workbench cell without wallet reads, provider work or a covering refetch', async () => {
    const agent = '7'.repeat(64), connector = '77777777-7777-4777-8777-777777777777';
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Connector helper')`, [agent]);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, reader]);
    await fixture.a.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,helper_agent_id,connector_type,status)
      VALUES($1,$2,$3,$4,'tailscale','connected')`, [connector, workspace(5), reader, agent]);
    const server = await fixture.server(fixture.a, ROUTER_FAMILIES);
    const initial=await server.request('readWorkbench', { workspaceId: workspace(5) });
    await server.barrier(); const position = server.frames.length;
    await fixture.b.query(`UPDATE workspace_connectors SET signed_in_as='committed@example.invalid' WHERE id=$1`, [connector]);
    await server.barrier();
    expect(server.requests.map(request => request.op)).toEqual(['readWorkbench']);
    const cells = replacements(server.frames, position).flatMap(value => value.connectors ?? []);
    expect(cells.filter(cell => cell.id === 'tailscale'),
      'F08 connector commit must carry its exact owner-scoped Workbench replacement').toEqual([
        {...projectWorkbenchDisplay(initial,reader).connectors.find(cell=>cell.id==='tailscale')!,signedInAs:'committed@example.invalid'}]);
  });

  it('F09: a committed portrait revision supplies the shared parent detail once for both consumers without an event read', async () => {
    const agent = '8'.repeat(64);
    await fixture.a.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Portrait helper')`, [agent]);
    await fixture.a.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, reader]);
    await fixture.a.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace(6), room(6), agent]);
    const server = await fixture.server(fixture.a, ROUTER_FAMILIES);
    const storage = new Map<string, string>();
    const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async key => storage.get(key) ?? null,
      set: async (key, value) => { storage.set(key, value); }, remove: async key => { storage.delete(key); } }));
    const address = { relayOrigin: 'https://synthetic.invalid', viewerPubkey: reader, endpoint: '/agent/:id', params: { agentId: agent } };
    const read = async () => (await server.request('readAgentProfile', { workspaceId: workspace(6), agentId: agent })).agent;
    const initial = await Promise.all([cache.fetch(address, isAgentDetailView, read), cache.fetch(address, isAgentDetailView, read)]);
    expect(initial[0]).toEqual(initial[1]); expect(initial[0]!.agent.identity.pubkey).toBe(agent);
    const updates = [0, 0];
    const stopParent = cache.subscribe(address, () => { updates[0]!++; });
    const stopPortrait = cache.subscribe(address, () => { updates[1]!++; });
    await server.barrier(); const position = server.frames.length;
    await fixture.b.query(`UPDATE identities SET avatar='https://synthetic.invalid/committed-portrait.png' WHERE id=$1`, [agent]);
    await server.barrier();
    expect(server.requests).toHaveLength(1);
    try {
      const details = replacements(server.frames, position).map(value => isAgentDetailView(value) ? value : value.agent).filter(isAgentDetailView);
      for (const detail of details) await cache.write(address, detail, isAgentDetailView);
      expect(updates, 'F09 parent and portrait each require one update from their shared canonical detail fact').toEqual([1, 1]);
      expect(cache.peek(address, isAgentDetailView)!.agent.identity.avatar).toBe('https://synthetic.invalid/committed-portrait.png');
    } finally { stopParent(); stopPortrait(); }
  });
});
