/** Built MCP tools + authenticated HTTP + PostgreSQL notifications + live sockets, in an isolated review Workspace. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { RoomView } from '@beeline/api-contract/phone';
import { PgliteDatabase } from '../apps/server/src/test-support.js';

const HUMAN = 'a'.repeat(64), RUBY = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
const built = (area: string, file: string) => pathToFileURL(resolve(`apps/${area}/dist`, file)).href;

async function main() {
  const { migrate } = await import(built('server', 'database.js')) as typeof import('../apps/server/src/database.js');
  const { TokenAuth } = await import(built('server', 'auth.js')) as typeof import('../apps/server/src/auth.js');
  const { PhoneService } = await import(built('server', 'phone-service.js')) as typeof import('../apps/server/src/phone-service.js');
  const { DaemonService } = await import(built('server', 'daemon-service.js')) as typeof import('../apps/server/src/daemon-service.js');
  const { LiveHub } = await import(built('server', 'live.js')) as typeof import('../apps/server/src/live.js');
  const { createBeelineServer } = await import(built('server', 'server.js')) as typeof import('../apps/server/src/server.js');
  const { PostgresLiveListener, POSTGRES_LIVE_CHANNEL } = await import(built('server', 'postgres-live.js')) as typeof import('../apps/server/src/postgres-live.js');
  const { DaemonApiClient } = await import(built('body', 'daemon-api-client.js')) as typeof import('../apps/body/src/daemon-api-client.js');
  const { AgentScheduleLoop } = await import(built('server', 'agent-schedules.js')) as typeof import('../apps/server/src/agent-schedules.js');
  const { GitHubOperations } = await import(built('server', 'github-operations.js')) as typeof import('../apps/server/src/github-operations.js');
  const db = new PgliteDatabase();
  const scratch = await mkdtemp(resolve('.command-proof-'));
  const live = new LiveHub();
  const payloads: string[] = [];
  class ListenClient extends EventEmitter {
    release?: () => Promise<void>;
    async connect() {}
    async query(sql: string) {
      assert.equal(sql, `LISTEN ${POSTGRES_LIVE_CHANNEL}`);
      this.release = await db.client.listen(POSTGRES_LIVE_CHANNEL, payload => {
        payloads.push(payload);
        this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload });
      });
    }
    async end() { await this.release?.(); }
  }
  const listener = new PostgresLiveListener(db, live, () => new ListenClient());
  const auth = new TokenAuth(db, async () => ({ subject: 'command-proof', login: 'proofcaptain', name: 'Proof Captain' }));
  const server = createBeelineServer({ database: db, auth, live,
    phone: new PhoneService(db, 'http://proof'), daemon: new DaemonService(db, live), mediaMaximumBytes: 1024 * 1024 });
  const off: Array<() => void> = [];
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Proof Captain','captain'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`, [HUMAN, RUBY, WORKER]);
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
      VALUES('github','command-proof',$1,'https://github.com','beeline','proofcaptain')`, [HUMAN]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [RUBY, WORKER, HUMAN]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Review command grammar proof')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES
      ($1,$3,'Widgets',NULL),($2,$3,'Captain and Ruby',jsonb_build_array($4::text,$5::text))`, [ROOM, DM, WORKSPACE, HUMAN, RUBY]);
    for (const who of [HUMAN, RUBY, WORKER]) {
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WORKSPACE, who, ROOM]);
      if (who !== WORKER) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member')`, [WORKSPACE, DM, who]);
    }
    void listener.run();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const phoneToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    async function token(agent: string) {
      return (await auth.exchangeDaemonToken((await auth.createDaemonExchange(agent)).exchangeToken))!.daemonToken;
    }
    const rubyToken = await token(RUBY), workerToken = await token(WORKER);
    async function call(name: string, input: unknown, bearer = rubyToken, surface = 'daemon') {
      const response = await fetch(`${origin}/v1/${surface}/operations/${name}`, { method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
      return await response.json() as Record<string, unknown>;
    }
    async function phoneRoom(room: string): Promise<RoomView> {
      const response = await fetch(`${origin}/v1/phone/rooms/${room}`, { headers: { authorization: `Bearer ${phoneToken}` } });
      assert.equal(response.status, 200);
      return await response.json() as RoomView;
    }
    const rubyApi = new DaemonApiClient(origin, rubyToken, RUBY);
    const workerApi = new DaemonApiClient(origin, workerToken, WORKER);
    const rubyPush = new Map<string, AgentCommand>(), workerPush = new Map<string, AgentCommand>();
    const subscriptions = new Map<string, Array<(commands: readonly AgentCommand[]) => void>>();
    function subscribe(api: InstanceType<typeof DaemonApiClient>, room: string, received: Map<string, AgentCommand>) {
      off.push(api.liveSubscribe(room, undefined, undefined, undefined, undefined, commands => {
        for (const command of commands) received.set(command.id, command);
        for (const accept of subscriptions.get(api.agentId) ?? []) accept(commands);
      }));
    }
    function pushed(agent: string, predicate: (command: AgentCommand) => boolean): Promise<AgentCommand> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('live push timed out')), 10_000);
        const handlers = subscriptions.get(agent) ?? [];
        const accept = (commands: readonly AgentCommand[]) => {
          const match = commands.find(predicate);
          if (!match) return;
          clearTimeout(timer);
          handlers.splice(handlers.indexOf(accept), 1);
          resolve(match);
        };
        handlers.push(accept); subscriptions.set(agent, handlers);
      });
    }
    subscribe(rubyApi, DM, rubyPush);
    const initialPush = pushed(RUBY, command => command.reason === 'direct_message');
    await call('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Build the widget in the Widgets Room' }, phoneToken, 'phone');
    const initial = await initialPush;
    async function claim(command: AgentCommand, bearer = rubyToken) {
      await call('claimAgentCommand', { roomId: command.roomId, commandId: command.id, generationId: 'proof-generation' }, bearer);
    }
    await claim(initial);
    async function mcp(command: AgentCommand, name: string, args: Record<string, unknown>) {
      const contextPath = join(scratch, `${command.agentId}.json`);
      await writeFile(contextPath, JSON.stringify({ roomId: command.roomId, requestId: command.turnRequestId, generationId: 'proof-generation' }));
      const child = spawn(process.execPath, [resolve('apps/body/dist/read-only-mcp.js')], { env: {
        ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_AGENT_DM: command.roomId === DM ? '1' : '0',
        BEELINE_DAEMON_ROOM_ID: command.roomId === DM ? DM : ROOM,
        BEELINE_DAEMON_CORNER_ID: command.roomId === DM ? '' : command.roomId,
        BEELINE_DAEMON_AGENT_ID: command.agentId,
        BEELINE_TURN_CONTEXT_FILE: contextPath, BEELINE_DAEMON_BASE_URL: origin,
        BEELINE_DAEMON_TOKEN: command.agentId === RUBY ? rubyToken : workerToken,
      }, stdio: ['pipe', 'pipe', 'pipe'] });
      try {
        const result = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 15_000);
          child.once('error', reject);
          child.once('exit', code => { clearTimeout(timer); reject(new Error(`MCP exited: ${code}`)); });
          createInterface({ input: child.stdout }).on('line', line => {
            const frame = JSON.parse(line);
            if (frame.id !== 2) return;
            clearTimeout(timer);
            if (frame.error || frame.result?.isError) reject(new Error(JSON.stringify(frame)));
            else resolve(frame.result.content[0].text);
          });
        });
        for (const frame of [
          { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'command-proof', version: '1' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
        ]) child.stdin.write(`${JSON.stringify(frame)}\n`);
        return await result;
      } finally { child.kill(); }
    }
    const rooms = JSON.parse(await mcp(initial, 'list_rooms', {})).rooms as Array<{ roomId: string; name: string }>;
    const target = rooms.find(room => room.name === 'Widgets')!;
    assert.equal(target.roomId, ROOM);
    const opened = JSON.parse(await mcp(initial, 'open_corner', { room: target.roomId, name: 'Widget', objective: 'Build the widget',
      implementer: 'worker', brief: { spec: 'Build the widget', approval: { sourceMessageId: initial.sourceMessageId } } }));
    const corner = opened.cornerId as string;
    assert.ok(JSON.parse(await mcp(initial, 'list_corners', {})).corners.some((item: { cornerId: string }) => item.cornerId === corner));
    assert.ok(JSON.parse(await mcp(initial, 'list_room_members', { address: target.roomId })).members.some((item: { handle: string }) => item.handle === 'worker'));
    console.log('PASS: built open_corner opens in a member Room from Ruby’s DM');
    subscribe(workerApi, corner, workerPush);
    const worker = await pushed(WORKER, command => command.reason === 'corner_objective');
    await claim(worker, workerToken);
    const blockedPush = pushed(RUBY, command => command.reason === 'report' && command.source.body.startsWith('blocked:'));
    await mcp(worker, 'report', { text: 'blocked: need an endpoint decision' });
    const blocked = await blockedPush;
    assert.equal(blocked.private, true);
    await claim(blocked);
    const orderPush = pushed(WORKER, command => command.reason === 'order');
    await mcp(blocked, 'order', { address: corner, text: 'Use the new endpoint' });
    assert.equal((await orderPush).private, true);
    console.log('PASS: private blocked report and private return order arrive through live sockets');
    await mcp(blocked, 'report', { text: 'needs-decision: choose the endpoint policy' });
    const humanView = await phoneRoom(DM);
    assert.ok(humanView.messages.some(message => message.text === 'needs-decision: choose the endpoint policy'));
    console.log('PASS report-tags-1: an untagged report appears unchanged in the captain’s originating DM');
    const taggedText = `needs-decision: choose the endpoint policy @${humanView.viewer.identity.handle}`;
    await mcp(blocked, 'report', { text: taggedText });
    assert.ok((await phoneRoom(DM)).messages.some(message => message.text === taggedText));
    console.log('PASS report-tags-1: an agent-written human mention is preserved exactly once');
    const before = rubyPush.size;
    await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at)
      VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":1}','Run the widget check',1,now()-interval '1 minute')`, [randomUUID(), WORKSPACE, corner, WORKER]);
    assert.equal(await new AgentScheduleLoop(db).runOnce(), 1);
    // Flush all earlier committed notifications on the same channel, without a polling loop.
    const flushed = new Promise<void>(async resolve => {
      const release = await db.client.listen(POSTGRES_LIVE_CHANNEL, payload => {
        if (payload === 'proof-barrier') { void release(); resolve(); }
      });
      await db.query(`SELECT pg_notify($1,'proof-barrier')`, [POSTGRES_LIVE_CHANNEL]);
    });
    await flushed;
    assert.equal(rubyPush.size, before);
    console.log('PASS: an actual corner schedule tick sends no lifecycle wake to Ruby');
    await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(77,$1,'42','owner','User','selected','active')`, [HUMAN]);
    await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(101,77,'owner/widgets','main')`);
    await db.query(`UPDATE rooms SET repository_key='owner/widgets',github_installation_id=77 WHERE id=$1`, [ROOM]);
    const branch = `feature/corner-${corner.replaceAll('-', '').slice(0, 12)}`;
    await db.query(`UPDATE corner_facts SET feature_branch=$2,lifecycle=$3::jsonb WHERE corner_id=$1`, [corner, branch,
      JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 42, url: 'https://github.com/owner/widgets/pull/42', headSha: '9'.repeat(40), targetBranch: 'main' } })]);
    const mergePush = pushed(RUBY, command => command.reason === 'watched_corner' && command.source.systemEvent?.kind === 'merged');
    const github = new GitHubOperations(db, {} as never, { deleteBranch: async () => {} } as never, 'proof');
    await github.processWebhook('pull_request', { installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action: 'closed',
      pull_request: { number: 42, title: 'Widget', html_url: 'https://github.com/owner/widgets/pull/42', merged: true,
        merge_commit_sha: '8'.repeat(40), head: { ref: branch, sha: '9'.repeat(40) }, base: { ref: 'main' } } });
    assert.equal((await mergePush).private, true);
    console.log('PASS: a real merge webhook delivers a private corner lifecycle wake to Ruby');
    for (const room of [ROOM, DM, corner]) {
      const view = await phoneRoom(room);
      for (const text of ['blocked: need an endpoint decision', 'Use the new endpoint'])
        assert.equal(view.messages.some(message => message.text === text), false);
    }
    assert.ok(payloads.every(payload => !payload.includes('need an endpoint decision') && !payload.includes('Use the new endpoint')));
    console.log('PASS: private coordination is absent from transcripts and id-only PostgreSQL notification payloads');
  } finally {
    for (const close of off) close();
    await listener.stop();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
