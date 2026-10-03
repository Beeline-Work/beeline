/** Built helper MCP -> authenticated server -> phone-visible sibling steer. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { RoomView } from '@beeline/api-contract/phone';

const HUMAN = 'a'.repeat(64),
  SENDER = 'b'.repeat(64),
  OPENER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';

async function main(): Promise<void> {
  const db = new PgliteDatabase();
  const root = await mkdtemp(join(tmpdir(), 'beeline-sibling-proof-'));
  const live = new LiveHub();
  const auth = new TokenAuth(db, async () => ({
    subject: 'steer-proof',
    login: 'proofhuman',
    name: 'Proof Human',
  }));
  const server = createBeelineServer({
    database: db,
    auth,
    live,
    phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live),
    mediaMaximumBytes: 1024 * 1024,
  });
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Proof Human','proofhuman'),($2,'agent','Sender','sender'),($3,'agent','Opener','opener')`,
      [HUMAN, SENDER, OPENER],
    );
    await db.query(
      `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','steer-proof',$1,'https://github.com','beeline','proofhuman')`,
      [HUMAN],
    );
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [
      SENDER,
      OPENER,
      HUMAN,
    ]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Steer proof')", [WORKSPACE]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$4,'Parent'),($2,$4,'Source corner'),($3,$4,'Target corner')`,
      [ROOM, SOURCE, TARGET, WORKSPACE],
    );
    await db.query('UPDATE rooms SET parent_id=$1 WHERE id IN ($2,$3)', [ROOM, SOURCE, TARGET]);
    for (const [corner, opener] of [
      [SOURCE, SENDER],
      [TARGET, OPENER],
    ])
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Coordinate input','{}')`,
        [corner, opener],
      );
    for (const person of [HUMAN, SENDER, OPENER])
      for (const room of [null, ROOM, SOURCE, TARGET])
        await db.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
          [WORKSPACE, room, person, person === HUMAN ? 'owner' : 'member'],
        );
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}'),($1,$3,'presence','presence','{"status":"online"}')`,
      [ROOM, SENDER, OPENER],
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const phoneToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
    async function daemonToken(agentId: string) {
      const exchange = await auth.createDaemonExchange(agentId);
      return (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
    }
    const senderToken = await daemonToken(SENDER),
      openerToken = await daemonToken(OPENER);
    async function call(name: string, input: unknown, token = senderToken, surface = 'daemon') {
      const response = await fetch(`${origin}/v1/${surface}/operations/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
      return (await response.json()) as Record<string, unknown>;
    }
    async function readRoom(roomId: string): Promise<RoomView> {
      const response = await fetch(`${origin}/v1/phone/rooms/${roomId}`, {
        headers: { authorization: `Bearer ${phoneToken}` },
      });
      assert.equal(response.status, 200);
      return (await response.json()) as RoomView;
    }
    await call(
      'sendRoomMessage',
      { roomId: SOURCE, text: '@sender steer the sibling to use the new endpoint' },
      phoneToken,
      'phone',
    );
    const source = (
      (await call('getAgentCommands', { roomId: SOURCE })).commands as AgentCommand[]
    )[0]!;
    await call('claimAgentCommand', {
      roomId: SOURCE,
      commandId: source.id,
      generationId: 'proof-generation',
    });
    const contextPath = join(root, 'command.json');
    const context = {
      roomId: SOURCE,
      requestId: source.turnRequestId,
      generationId: 'proof-generation',
    };
    await writeFile(contextPath, JSON.stringify(context));
    const child = spawn(process.execPath, [resolve('apps/body/dist/read-only-mcp.js')], {
      env: {
        ...process.env,
        BEELINE_MCP_SURFACE: 'agent',
        BEELINE_AGENT_DM: '0',
        BEELINE_CORNER_LANE: 'code',
        BEELINE_DAEMON_ROOM_ID: ROOM,
        BEELINE_DAEMON_CORNER_ID: SOURCE,
        BEELINE_TURN_CONTEXT_FILE: contextPath,
        BEELINE_DAEMON_BASE_URL: origin,
        BEELINE_DAEMON_TOKEN: senderToken,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const answer = new Promise<{
        result?: { isError?: boolean; content: Array<{ text: string }> };
        error?: unknown;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP steer timed out')), 20_000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', () => {
          clearTimeout(timer);
          reject(new Error('MCP exited before delivery'));
        });
        createInterface({ input: child.stdout }).on('line', (line) => {
          const message = JSON.parse(line);
          if (message.id === 2) {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });
      for (const frame of [
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'sibling-proof', version: '1' },
          },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'steer_corner',
            arguments: { cornerId: TARGET, text: 'Use the new endpoint' },
          },
        },
      ])
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      const response = await answer;
      assert.equal(response.error, undefined);
      assert.notEqual(response.result?.isError, true);
      const delivered = JSON.parse(response.result!.content[0]!.text);
      const view = await readRoom(TARGET);
      const cards = view.messages.filter((message) => message.id === delivered.id);
      assert.equal(cards.length, 1);
      assert.equal(cards[0]!.text, 'Use the new endpoint');
      assert.equal(cards[0]!.relay?.fromRoomId, SOURCE);
      assert.equal(cards[0]!.relay?.fromName, 'Source corner');
      const queued = (await call('getAgentCommands', { roomId: TARGET }, openerToken))
        .commands as AgentCommand[];
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.reason, 'relay_steer');
      assert.equal(queued[0]!.parentCommandId, source.id);
      assert.equal(queued[0]!.rootSourceMessageId, source.rootSourceMessageId);
      assert.equal(
        (await db.query('SELECT state FROM agent_commands WHERE id=$1', [source.id])).rows[0]!
          .state,
        'claimed',
      );
      await call(
        'claimAgentCommand',
        { roomId: TARGET, commandId: queued[0]!.id, generationId: 'opener-generation' },
        openerToken,
      );
      const claimedView = await readRoom(TARGET);
      assert.ok(
        claimedView.latestAgentTurns.some(
          (turn) => turn.requestId === queued[0]!.turnRequestId && turn.requestedBy === HUMAN,
        ),
      );
      await call('postRoomMessage', { ...context, text: 'Source work continues' });
      const sourceView = await readRoom(SOURCE);
      assert.ok(sourceView.messages.some((message) => message.text === 'Source work continues'));
      console.log(
        'PASS: built steer_corner delivers one phone-visible card FROM Source corner with "Use the new endpoint".',
      );
      console.log(
        'PASS: one destination opener command preserves the root human requester and parent command; source turn remains active and replies afterwards.',
      );
    } finally {
      child.kill();
    }
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
