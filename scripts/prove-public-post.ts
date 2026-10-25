/** R1: built public posting tool through authenticated HTTP, isolated SQL and phone reads. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { declareCornerProofOutput } from '../apps/body/src/corner-proof-output.js';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { RoomView } from '@beeline/api-contract/phone';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { piMcpBridgeSource } from '../apps/body/src/pi-mcp-bridge.js';
import { finalAgentMessageText, toolCallEntries, type SessionUpdate } from '../apps/body/src/acp.js';

const HUMAN = 'a'.repeat(64), RUBY = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
const built = (area: string, file: string) => pathToFileURL(resolve(`apps/${area}/dist`, file)).href;

async function main() {
  const { migrate } = await import(built('server', 'database.js')) as typeof import('../apps/server/src/database.js');
  const { flushDueCommanderWakes } = await import(built('server', 'commander-wakes.js')) as typeof import('../apps/server/src/commander-wakes.js');
  const { TokenAuth } = await import(built('server', 'auth.js')) as typeof import('../apps/server/src/auth.js');
  const { PhoneService } = await import(built('server', 'phone-service.js')) as typeof import('../apps/server/src/phone-service.js');
  const { DaemonService } = await import(built('server', 'daemon-service.js')) as typeof import('../apps/server/src/daemon-service.js');
  const { LiveHub } = await import(built('server', 'live.js')) as typeof import('../apps/server/src/live.js');
  const { createBeelineServer } = await import(built('server', 'server.js')) as typeof import('../apps/server/src/server.js');
  const { DaemonApiClient } = await import(built('body', 'daemon-api-client.js')) as typeof import('../apps/body/src/daemon-api-client.js');
  const db = new PgliteDatabase();
  const proofRoot = await declareCornerProofOutput(process.cwd(), basename(resolve(process.cwd())));
  const scratch = await mkdtemp(join(proofRoot, 'public-post-'));
  const live = new LiveHub();
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
    off.push(() => rubyApi.closeLive(), () => workerApi.closeLive());
    await call('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Build the widget in the Widgets Room' }, phoneToken, 'phone');
    await db.query(`UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL`);
    await flushDueCommanderWakes(db);
    const initial = (await rubyApi.execute('getAgentCommands', { roomId: DM })).commands[0]!;
    async function claim(command: AgentCommand, bearer = rubyToken) {
      await call('claimAgentCommand', { roomId: command.roomId, commandId: command.id, generationId: 'proof-generation' }, bearer);
    }
    await claim(initial);
    async function mcp(command: AgentCommand, name: string, args: Record<string, unknown>, viaPi = false) {
      const contextPath = join(scratch, `${command.agentId}.json`);
      await writeFile(contextPath, JSON.stringify({ roomId: command.roomId, requestId: command.turnRequestId, generationId: 'proof-generation', commandReason: command.reason }));
      const env = {
        ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_AGENT_DM: command.roomId === DM ? '1' : '0',
        BEELINE_DAEMON_ROOM_ID: command.roomId === DM ? DM : ROOM,
        BEELINE_DAEMON_CORNER_ID: command.roomId === DM ? '' : command.roomId,
        BEELINE_DAEMON_AGENT_ID: command.agentId,
        BEELINE_TURN_CONTEXT_FILE: contextPath, BEELINE_DAEMON_BASE_URL: origin,
        BEELINE_DAEMON_TOKEN: command.agentId === RUBY ? rubyToken : workerToken,
      };
      if (viaPi) {
        const bridgePath = join(scratch, 'pi-post-bridge.mjs');
        await writeFile(bridgePath, piMcpBridgeSource([{ name: 'beeline-agent', command: process.execPath,
          args: [resolve('apps/body/dist/read-only-mcp.js')],
          env: Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([name, value]) => ({ name, value })),
        }]));
        const bridge = await import(pathToFileURL(bridgePath).href);
        let post: { execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }> } | undefined;
        await bridge.default({ registerTool: (tool: { name: string; execute: NonNullable<typeof post>['execute'] }) => {
          if (tool.name === 'beeline-agent__post') post = tool;
        } });
        assert.ok(post, 'Pi must discover post from the real MCP server');
        return (await post.execute('pi-post-1', args)).content[0]!.text;
      }
      const child = spawn(process.execPath, [resolve('apps/body/dist/read-only-mcp.js')], {
        env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const posted = JSON.parse(await mcp(initial, 'post', { address: ROOM, text: 'R1 public Room post' }));
    assert.equal(posted.stored, true);
    assert.ok((await phoneRoom(ROOM)).messages.some(message => message.id === posted.id && message.text === 'R1 public Room post'));
    console.log('PASS R1: built post tool → authenticated HTTP → stored message visible in phone Room read');
    // R-REASONING-POST: no production Room/transcript is read. These synthetic
    // ACP updates exercise Beeline's shared boundary, not external adapter internals.
    for (const viaPi of [false, true]) {
      const text = `Final **reply** via ${viaPi ? 'Pi bridge' : 'direct MCP'}.`;
      const updates: SessionUpdate[] = [
        { sessionId: 'proof', update: { sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'PRIVATE_SENTINEL' } } },
        { sessionId: 'proof', update: { sessionUpdate: 'tool_call', toolCallId: 'post-1',
          title: 'post', rawInput: { address: ROOM, text } } },
        { sessionId: 'proof', update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Finished.' } } },
      ];
      assert.equal(finalAgentMessageText(updates), 'Finished.');
      const args = toolCallEntries(updates)[0]!.rawInput as Record<string, unknown>;
      const receipt = JSON.parse(await mcp(initial, 'post', args, viaPi));
      const visible = (await phoneRoom(ROOM)).messages.find(message => message.id === receipt.id);
      assert.equal(visible?.text, text);
      assert.ok(!visible.text.includes('PRIVATE_SENTINEL'));
      console.log(`PASS R-REASONING-POST: separate ACP thought + ${viaPi ? 'generated Pi bridge' : 'MCP'} post → phone sees exact final text`);
    }
    // Inline reasoning at the start of the model's tool argument must not become
    // a public Room message. Quoted examples inside a reply remain reply text.
    for (const tag of ['think', 'thinking']) {
      const text = `<${tag}>MODEL_AUTHORED_SENTINEL</${tag}>Final reply.`;
      const receipt = JSON.parse(await mcp(initial, 'post', { address: ROOM, text }));
      assert.equal((await phoneRoom(ROOM)).messages.find(message => message.id === receipt.id)?.text, 'Final reply.');
      console.log(`PASS R-REASONING-POST: leading <${tag}> in post.text is removed before phone Room read`);
    }
    const quoted = 'Example:\n```xml\n<think>Visible example</think>\n```\n\nFinal paragraph.';
    const quotedReceipt = JSON.parse(await mcp(initial, 'post', { address: ROOM, text: quoted }));
    assert.equal((await phoneRoom(ROOM)).messages.find(message => message.id === quotedReceipt.id)?.text, quoted);
    for (const text of ['<think>PRIVATE_ONLY</think>', '<thinking>PRIVATE_UNFINISHED']) {
      await assert.rejects(mcp(initial, 'post', { address: ROOM, text }), /reasoning block contains no public reply/);
    }
    assert.equal((await db.query(`SELECT id FROM messages WHERE text LIKE '%PRIVATE_ONLY%' OR text LIKE '%PRIVATE_UNFINISHED%'`)).rowCount, 0);
    console.log('PASS R-REASONING-POST: quoted tags unchanged; reasoning-only posts refused without a stored message');
    const opened = JSON.parse(await mcp(initial, 'open_corner', { room: ROOM, name: 'posting-proof', objective: 'Prove public posting',
      implementer: 'worker', brief: { spec: 'Prove public posting', repositoryWork: false, approval: { sourceMessageId: initial.sourceMessageId } } }));
    const corner = opened.address as string;
    await db.query(`UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL`);
    await flushDueCommanderWakes(db);
    const command = (await workerApi.execute('getAgentCommands', { roomId: corner })).commands[0]!;
    await claim(command, workerToken);
    const note = JSON.parse(await mcp(command, 'post', { text: 'R1 active corner post' }));
    assert.equal(note.address, corner);
    assert.ok((await phoneRoom(corner)).messages.some(message => message.id === note.id));
    console.log('PASS R1: omitted address posts visibly to the active corner');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, RUBY]);
    await assert.rejects(mcp(initial, 'post', { address: ROOM, text: 'Must not be stored' }), /403: post refused: agent is not a current member/);
    assert.equal((await db.query(`SELECT id FROM messages WHERE text='Must not be stored'`)).rowCount, 0);
    console.log('PASS R1: removed member receives a clear refusal and no message is stored');
  } finally {
    for (const close of off) close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode ?? 0));
