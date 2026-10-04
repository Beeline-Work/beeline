/**
 * `@agent login`, end to end: authenticated phone HTTP -> server ->
 * PostgreSQL NOTIFY -> the helper's live socket -> a real helper client that
 * builds the PKCE link and writes the shared Claude login. Only Claude's own
 * token and profile endpoints are faked; nothing else is.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { DaemonApiClient } from '../apps/body/src/daemon-api-client.js';
import {
  answerClaudeSignInFrame,
  CLAUDE_OAUTH,
  ClaudeSignIn,
} from '../apps/body/src/claude-sign-in.js';

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
  const home = await mkdtemp(join(tmpdir(), 'beeline-claude-sign-in-proof-'));
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
    const signIn = new ClaudeSignIn({ operatorHome: home, fetch: claude });
    const helperLog: string[] = [];
    const client = helper;
    helper.setClaudeSignInListener((frame) => {
      void answerClaudeSignInFrame(client, AGENT, signIn, frame, (line) => helperLog.push(line));
    });
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
    async function roomCard(): Promise<RoomViewMessage | undefined> {
      const response = await fetch(`${origin}/v1/phone/rooms/${ROOM}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      const room = (await response.json()) as { messages: RoomViewMessage[] };
      return room.messages.filter((message) => message.claudeSignIn).at(-1);
    }
    async function cardSettles(status: string): Promise<RoomViewMessage> {
      for (let attempt = 0; attempt < 400; attempt++) {
        const card = await roomCard();
        if (card?.claudeSignIn?.status === status) return card;
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

    await phone(memberToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara login' });
    console.log(`Workspace admin (not the owner) sends "@clara login" -> ${await lastSystemLine()}`);

    await phone(ownerToken, 'sendRoomMessage', { roomId: ROOM, text: '@clara login' });
    const card = await cardSettles('pending');
    const link = new URL(String(card.claudeSignIn!.authorizeUrl));
    console.log(`Owner sends "@clara login" -> card: ${card.text}`);
    console.log(`  card link: ${link.origin}${link.pathname}?client_id=${link.searchParams.get('client_id')}&redirect_uri=${link.searchParams.get('redirect_uri')}&code_challenge_method=${link.searchParams.get('code_challenge_method')}&…`);
    const modelCommands = await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [AGENT]);
    console.log(`  model turns started by the command: ${modelCommands.rowCount}`);
    assert.equal(modelCommands.rowCount, 0);
    const state = link.searchParams.get('state')!;

    const stale = await phone(ownerToken, 'completeClaudeSignIn', {
      roomId: ROOM,
      messageId: card.id,
      code: `expired-code#${state}`,
    });
    const afterStale = await cardSettles('failed');
    console.log(`Owner pastes an expired code into the card -> ${stale.status}; card shows: ${afterStale.claudeSignIn!.errorMessage}`);
    assert.notEqual(stale.status, 200);

    const done = await phone(ownerToken, 'completeClaudeSignIn', {
      roomId: ROOM,
      messageId: card.id,
      code: `${GOOD_CODE}#${state}`,
    });
    const signedIn = await cardSettles('signed-in');
    console.log(`Owner pastes the code claude.ai showed -> ${done.status} ${JSON.stringify(done.body)}; card status ${signedIn.claudeSignIn!.status}`);
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
    console.log(`Helper stopped; owner sends "@clara /login" -> card shows: ${offline.claudeSignIn!.errorMessage}`);
    assert.match(String(offline.claudeSignIn!.errorMessage), /offline/);
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
