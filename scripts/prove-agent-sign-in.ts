/**
 * `@agent /login`, end to end, for three of the four sign-in kinds:
 * authenticated phone HTTP -> server -> PostgreSQL NOTIFY -> the helper's
 * live socket -> a real helper client (`AgentSignIn`) that writes the login
 * where the harness reads it. Faked: Claude's token/profile endpoints,
 * OpenRouter's key check, and the `codex` binary (a stand-in that prints the
 * real Codex 0.160.0 device-code output and exits 0 when "approved").
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { DaemonApiClient } from '../apps/body/src/daemon-api-client.js';
import {
  AgentSignIn,
  answerAgentSignInFrame,
  reportAgentSignInResult,
  type AgentSignInOptions,
} from '../apps/body/src/agent-sign-in.js';
import { CODEX_DEVICE_OUTPUT } from '../apps/body/src/agent-sign-in.fixtures.js';
import { CLAUDE_OAUTH } from '../apps/body/src/claude-sign-in.js';

const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const GOOD_CODE = 'approved-on-claude-ai';

async function main(): Promise<void> {
  const serverBuild = (file: string) => pathToFileURL(resolve('apps/server/dist', file)).href;
  const { migrate } = (await import(
    serverBuild('database.js')
  )) as typeof import('../apps/server/src/database.js');
  const { TokenAuth } = (await import(
    serverBuild('auth.js')
  )) as typeof import('../apps/server/src/auth.js');
  const { PhoneService } = (await import(
    serverBuild('phone-service.js')
  )) as typeof import('../apps/server/src/phone-service.js');
  const { DaemonService } = (await import(
    serverBuild('daemon-service.js')
  )) as typeof import('../apps/server/src/daemon-service.js');
  const { LiveHub } = (await import(
    serverBuild('live.js')
  )) as typeof import('../apps/server/src/live.js');
  const { ConnectionPresence } = (await import(
    serverBuild('connection-presence.js')
  )) as typeof import('../apps/server/src/connection-presence.js');
  const { POSTGRES_LIVE_CHANNEL, PostgresLiveListener } = (await import(
    serverBuild('postgres-live.js')
  )) as typeof import('../apps/server/src/postgres-live.js');
  const { createBeelineServer } = (await import(
    serverBuild('server.js')
  )) as typeof import('../apps/server/src/server.js');

  const db = new PgliteDatabase();
  await migrate(db);
  class ListenClient extends EventEmitter {
    release?: () => Promise<void>;
    async connect() {}
    async query() {
      this.release = await db.client.listen(POSTGRES_LIVE_CHANNEL, (payload) =>
        this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }),
      );
    }
    async end() {
      await this.release?.();
    }
  }
  const live = new LiveHub();
  const listener = new PostgresLiveListener(db, live, () => new ListenClient() as never, 1);
  void listener.run();
  const ownerAuth = new TokenAuth(db, async () => ({ subject: 'owner', login: 'owner', name: 'Owner' }));
  const memberAuth = new TokenAuth(db, async () => ({ subject: 'member', login: 'member', name: 'Member' }));
  const presence = new ConnectionPresence(db, live, 1_000);
  const server = createBeelineServer({
    database: db,
    auth: ownerAuth,
    live,
    phone: new PhoneService(db, 'http://proof', undefined, undefined, live),
    daemon: new DaemonService(db, live),
    connectionPresence: presence,
    mediaMaximumBytes: 1024 * 1024,
  });
  const home = await mkdtemp(join(tmpdir(), 'beeline-agent-sign-in-proof-'));
  let helper: DaemonApiClient | undefined;
  try {
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Member','member'),($3,'agent','Clara','clara')`,
      [OWNER, MEMBER, AGENT],
    );
    await db.query(
      `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
       VALUES('github','owner',$1,'https://github.com','beeline','owner'),
             ('github','member',$2,'https://github.com','beeline','member')`,
      [OWNER, MEMBER],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'claude')`, [AGENT, OWNER]);
    for (const [identity, role] of [[OWNER, 'owner'], [MEMBER, 'admin'], [AGENT, 'member']] as const)
      for (const room of [null, ROOM])
        await db.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
          [WORKSPACE, room, identity, role],
        );

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ownerToken = (await ownerAuth.exchangeGitHubOidc('proof')).accessToken;
    const memberToken = (await memberAuth.exchangeGitHubOidc('proof')).accessToken;
    const exchange = await ownerAuth.createDaemonExchange(AGENT);
    const daemonToken = (await ownerAuth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;

    // The agent's machine: an expired shared Claude login, linked into a Room home.
    const shared = join(home, '.claude', '.credentials.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      shared,
      JSON.stringify({ claudeAiOauth: { accessToken: 'expired', refreshToken: 'dead', expiresAt: 1 } }),
      { mode: 0o600 },
    );
    const roomLink = join(home, 'rooms', ROOM, 'agent-home', 'claude', '.credentials.json');
    await mkdir(join(roomLink, '..'), { recursive: true });
    await symlink(shared, roomLink);

    const claudeRequests: Array<Record<string, unknown>> = [];
    const claude = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === CLAUDE_OAUTH.profileUrl)
        return new Response(JSON.stringify({ organization: { organization_type: 'claude_max' } }));
      assert.equal(String(url), CLAUDE_OAUTH.tokenUrl);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      claudeRequests.push(body);
      if (body.code !== GOOD_CODE)
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response(
        JSON.stringify({
          access_token: 'sk-ant-oat01-fresh-access',
          refresh_token: 'sk-ant-ort01-fresh-refresh',
          expires_in: 28_800,
          scope: CLAUDE_OAUTH.scopes.join(' '),
        }),
      );
    }) as typeof fetch;
    helper = new DaemonApiClient(origin, daemonToken, AGENT);
    const helperLog: string[] = [];
    const client = helper;
    const cards = new Map<string, string>();
    const log = (line: string) => helperLog.push(line);
    // One helper connection; each phase runs the harness the agents row names.
    const useHarness = async (harness: AgentSignInOptions['harness'], extra: Partial<AgentSignInOptions>) => {
      await db.query(`UPDATE agents SET harness=$2 WHERE agent_id=$1`, [AGENT, harness]);
      const signIn = new AgentSignIn({
        harness,
        operatorHome: home,
        agentEnv: { PATH: process.env.PATH ?? '' },
        onResult: (attemptId, result) =>
          void reportAgentSignInResult(client, AGENT, attemptId, cards, result, log),
        ...extra,
      });
      client.setAgentSignInListener((frame) => {
        void answerAgentSignInFrame(client, AGENT, signIn, frame, cards, log);
      });
    };
    await useHarness('claude', { fetch: claude });
    helper.liveSubscribe(ROOM, undefined, undefined, () => undefined);
    for (let attempt = 0; attempt < 200; attempt++) {
      const held = await db.query(
        `SELECT 1 FROM agent_connections WHERE agent_id=$1 AND released_at IS NULL`,
        [AGENT],
      );
      if (held.rowCount) break;
      await new Promise((done) => setTimeout(done, 25));
    }

    async function phone(token: string, name: string, input: Record<string, unknown>) {
      const response = await fetch(`${origin}/v1/phone/operations/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }
    async function roomCard(token = ownerToken): Promise<RoomViewMessage | undefined> {
      const response = await fetch(`${origin}/v1/phone/rooms/${ROOM}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const room = (await response.json()) as { messages: RoomViewMessage[] };
      return room.messages.filter((message) => message.agentSignIn).at(-1);
    }
    async function cardSettles(status: string): Promise<RoomViewMessage> {
      for (let attempt = 0; attempt < 400; attempt++) {
        const card = await roomCard();
        if (card?.agentSignIn?.status === status) return card;
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error(`card never reached ${status}`);
    }
    async function lastSystemLine(): Promise<string> {
      const row = await db.query<{ text: string }>(
        `SELECT text FROM messages WHERE room_id=$1 AND presentation IN ('system','card')
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [ROOM],
      );
      return row.rows[0]?.text ?? '';
    }

    await phone(memberToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara /login' });
    console.log(`Workspace admin (not the owner) sends "@clara /login" -> ${await lastSystemLine()}`);

    await phone(ownerToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara /login' });
    const card = await cardSettles('pending');
    const link = new URL(String(card.agentSignIn!.authorizeUrl));
    console.log(`Owner sends "@clara /login" -> card: ${card.text}`);
    console.log(`  card link: ${link.origin}${link.pathname}?client_id=${link.searchParams.get('client_id')}&redirect_uri=${link.searchParams.get('redirect_uri')}&code_challenge_method=${link.searchParams.get('code_challenge_method')}&…`);
    const modelCommands = await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [AGENT]);
    console.log(`  model turns started by the command: ${modelCommands.rowCount}`);
    assert.equal(modelCommands.rowCount, 0);
    const state = link.searchParams.get('state')!;

    const stale = await phone(ownerToken, 'completeAgentSignIn', {
      roomId: ROOM,
      messageId: card.id,
      code: `expired-code#${state}`,
    });
    const afterStale = await cardSettles('failed');
    console.log(`Owner pastes an expired code into the card -> ${stale.status}; card shows: ${afterStale.agentSignIn!.errorMessage}`);
    assert.notEqual(stale.status, 200);

    const done = await phone(ownerToken, 'completeAgentSignIn', {
      roomId: ROOM,
      messageId: card.id,
      code: `${GOOD_CODE}#${state}`,
    });
    const signedIn = await cardSettles('signed-in');
    console.log(`Owner pastes the code claude.ai showed -> ${done.status} ${JSON.stringify(done.body)}; card status ${signedIn.agentSignIn!.status}`);
    assert.deepEqual(done, { status: 200, body: { signedIn: true } });

    const roomView = JSON.parse(await readFile(roomLink, 'utf8')) as {
      claudeAiOauth: { accessToken: string; expiresAt: number; subscriptionType: string };
    };
    const mode = ((await stat(shared)).mode & 0o777).toString(8);
    console.log(
      `The Room's linked login now reads: accessToken=${roomView.claudeAiOauth.accessToken.slice(0, 14)}…, expiresAt=${new Date(roomView.claudeAiOauth.expiresAt).toISOString()}, subscriptionType=${roomView.claudeAiOauth.subscriptionType}; shared file mode ${mode}; Room link still a symlink: ${(await lstat(roomLink)).isSymbolicLink()}`,
    );
    assert.equal(roomView.claudeAiOauth.accessToken, 'sk-ant-oat01-fresh-access');
    assert.equal(mode, '600');
    assert.equal(claudeRequests.length, 2);

    const persisted = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    const hits: string[] = [];
    for (const { name } of persisted.rows) {
      const found = await db.query(`SELECT 1 FROM "${name}" row WHERE row::text LIKE $1 LIMIT 1`, [
        `%${GOOD_CODE}%`,
      ]);
      if (found.rowCount) hits.push(name);
    }
    console.log(`Tables holding the pasted code: ${hits.length ? hits.join(', ') : 'none'}; helper log lines naming it: ${helperLog.filter((line) => line.includes(GOOD_CODE)).length}`);
    assert.deepEqual(hits, []);

    // Device code (Codex): the machine runs `codex login --device-auth`.
    const codexRuns: Array<{ child: EventEmitter & { stdout: PassThrough }; env: NodeJS.ProcessEnv }> = [];
    const fakeCodex = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert.equal(`${command} ${args.join(' ')}`, 'codex login --device-auth');
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      codexRuns.push({ child, env: options.env });
      setTimeout(() => child.stdout.write(CODEX_DEVICE_OUTPUT), 50);
      return child;
    }) as never;
    await useHarness('codex', { spawn: fakeCodex });
    await phone(ownerToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara /login' });
    const device = await cardSettles('pending');
    console.log(`Codex agent: owner sends "@clara /login" -> card: ${device.text}`);
    console.log(`  owner's card: ${device.agentSignIn!.kind} · ${device.agentSignIn!.authorizeUrl} · code ${device.agentSignIn!.userCode}`);
    const memberView = (await roomCard(memberToken))!.agentSignIn!;
    console.log(`  admin's view of the same card: link ${memberView.authorizeUrl ?? 'hidden'}, code ${memberView.userCode ?? 'hidden'}`);
    assert.equal(device.agentSignIn!.userCode, 'EBQ9-VJCLN');
    assert.equal(memberView.userCode, undefined);
    assert.equal(codexRuns[0]!.env.HOME, home);
    codexRuns[0]!.child.emit('exit', 0, null);
    const approved = await cardSettles('signed-in');
    console.log(`  approved on the provider page (codex exits 0) -> card status ${approved.agentSignIn!.status}, with nothing pasted`);

    // API key (Pi): the key replaces the provider key `beeline connect` saved.
    const envFile = join(home, 'connect', 'agent.env');
    await mkdir(join(home, 'connect'), { recursive: true });
    await writeFile(envFile, 'OPENROUTER_API_KEY="sk-or-v1-old"\n', { mode: 0o600 });
    const PI_KEY = 'sk-or-v1-new-pasted-key';
    await useHarness('pi', {
      llmEnvFile: envFile,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Response('{}', {
          status: new Headers(init?.headers).get('authorization') === `Bearer ${PI_KEY}` ? 200 : 401,
        })) as typeof fetch,
    });
    await phone(ownerToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara /login' });
    const keyCard = await cardSettles('pending');
    console.log(`Pi agent: owner sends "@clara /login" -> card: ${keyCard.text} (${keyCard.agentSignIn!.kind}, ${keyCard.agentSignIn!.provider})`);
    const badKey = await phone(ownerToken, 'completeAgentSignIn', { roomId: ROOM, messageId: keyCard.id, code: 'sk-or-v1-wrong' });
    console.log(`  owner pastes a wrong key -> ${badKey.status} ${badKey.body.error}`);
    const goodKey = await phone(ownerToken, 'completeAgentSignIn', { roomId: ROOM, messageId: keyCard.id, code: PI_KEY });
    const savedKey = await cardSettles('signed-in');
    const envNow = await readFile(envFile, 'utf8');
    console.log(`  owner pastes the right key -> ${goodKey.status}; card ${savedKey.agentSignIn!.status}; env file now holds the new key: ${envNow.includes(PI_KEY)}, mode ${((await stat(envFile)).mode & 0o777).toString(8)}`);
    assert.equal(goodKey.status, 200);
    assert.ok(envNow.includes(PI_KEY));
    const keyHits: string[] = [];
    for (const { name } of persisted.rows) {
      const found = await db.query(`SELECT 1 FROM "${name}" row WHERE row::text LIKE $1 LIMIT 1`, [`%${PI_KEY}%`]);
      if (found.rowCount) keyHits.push(name);
    }
    console.log(`  tables holding the pasted key: ${keyHits.length ? keyHits.join(', ') : 'none'}; helper log lines naming it: ${helperLog.filter((line) => line.includes(PI_KEY)).length}`);
    assert.deepEqual(keyHits, []);

    helper.closeLive();
    helper = undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      const held = await db.query(
        `SELECT 1 FROM agent_connections WHERE agent_id=$1 AND released_at IS NULL`,
        [AGENT],
      );
      if (!held.rowCount) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    await phone(ownerToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara /login' });
    const offline = await cardSettles('failed');
    console.log(`Helper stopped; owner sends "@clara /login" -> card shows: ${offline.agentSignIn!.errorMessage}`);
    assert.match(String(offline.agentSignIn!.errorMessage), /offline/);
  } finally {
    helper?.closeLive();
    await listener.stop();
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
    await rm(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
