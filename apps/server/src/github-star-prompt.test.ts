import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { GitHubAppClient, type GitHubOAuthClient } from '@beeline/auth/github';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { GitHubOperations } from './github-operations.js';

const H = 'a'.repeat(64),
  A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222';
const CLIENT_SECRET = 'client-secret';
const USER_TOKEN = 'person-user-token';

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
let github: Server;
let starResponse = 204;
let starred = false;
const githubCalls: string[] = [];

/** The same sealing GitHubOperations uses for stored user tokens. */
function seal(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update(CLIENT_SECRET).digest(),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.');
}

const read = () => phone.execute('readStarPrompt', {}, H);
const answer = (action: 'star' | 'later' | 'dismiss', milestone: number) =>
  phone.execute('answerStarPrompt', { action, milestone }, H);

/** One full agent turn: the person tags the agent, the agent claims and replies. */
async function turn(text = 'hello', artifact = false): Promise<string> {
  await phone.execute('sendRoomMessage', { roomId: R, text: `@hoots ${text}` }, H);
  const commands = (await daemon.execute('getAgentCommands', { roomId: R }, A)).commands;
  const command = commands.at(-1) as AgentCommand;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: R, commandId: command.id, generationId: 'g1' },
    A,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    { roomId: R, agentId: A, requestId: command.turnRequestId, generationId: 'g1', status: 'working' },
    A,
  );
  if (artifact)
    await db.query(
      `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id,generation_id)
       VALUES($1,$2,'https://server.test/media/artifact','report.html','text/html',10,$3,'g1')`,
      [R, A, command.turnRequestId],
    );
  const reply = await daemon.execute(
    'postRoomMessage',
    { roomId: R, requestId: command.turnRequestId, generationId: 'g1', text: `answer to ${text}` },
    A,
  );
  // Out of the 30-second mid-conversation window.
  await db.query(`UPDATE messages SET created_at=created_at-interval '1 minute'`);
  return reply.id;
}

beforeAll(async () => {
  github = createServer((request, response) => {
    githubCalls.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    if (request.url !== '/user/starred/Beeline-Work/beeline') {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'PUT') {
      starred = starResponse === 204;
      response.writeHead(starResponse).end();
      return;
    }
    response.writeHead(starred ? 204 : 404).end();
  });
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
  const apiBaseUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Hoots','hoots')`,
    [H, A],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Stars')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [R, W]);
  for (const who of [H, A])
    for (const room of [null, R])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`,
    [R, A],
  );
  await db.query(
    `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github','42',$1,'https://github.com','github')`,
    [H],
  );
  await db.query(`INSERT INTO github_user_tokens(subject,encrypted_token) VALUES('42',$1)`, [
    seal(USER_TOKEN),
  ]);
  const operations = new GitHubOperations(
    db,
    {} as GitHubOAuthClient,
    new GitHubAppClient({ appId: '1', privateKey: 'unused', slug: 'beeline', apiBaseUrl }),
    CLIENT_SECRET,
  );
  phone = new PhoneService(db, 'http://test', operations);
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);

afterAll(async () => {
  await db?.close();
  await new Promise((resolve) => github?.close(resolve));
});

beforeEach(async () => {
  await db.query(`DELETE FROM github_star_prompts`);
  starResponse = 204;
  starred = false;
  githubCalls.length = 0;
});

it('shows the card on the first win after the 3rd reply and stars with the person token', async () => {
  const first = await turn('one');
  await turn('two');
  // Two replies and a 👍: no milestone yet.
  await phone.execute('reactToMessage', { roomId: R, messageId: first, emoji: '👍' }, H);
  expect(await read()).toEqual({ prompt: null });
  const third = await turn('three');
  // The milestone alone does not show the card; the next win does.
  expect(await read()).toEqual({ prompt: null });
  await phone.execute('reactToMessage', { roomId: R, messageId: third, emoji: '👍' }, H);
  expect(await read()).toEqual({
    prompt: {
      milestone: 3,
      repository: 'Beeline-Work/beeline',
      url: 'https://github.com/Beeline-Work/beeline',
    },
  });
  expect(githubCalls).toEqual([
    `GET /user/starred/Beeline-Work/beeline Bearer ${USER_TOKEN}`,
  ]);

  expect(await answer('star', 3)).toEqual({ outcome: 'starred' });
  expect(githubCalls.at(-1)).toBe(`PUT /user/starred/Beeline-Work/beeline Bearer ${USER_TOKEN}`);
  expect(starred).toBe(true);
  expect(await read()).toEqual({ prompt: null });
});

it('waits for a later win when the milestone reply itself carries the artifact', async () => {
  await turn('one');
  await turn('two');
  await turn('three with a report', true);
  expect(
    (await db.query<{ attachments: unknown[] }>(
      `SELECT attachments FROM messages WHERE text='answer to three with a report'`,
    )).rows[0]?.attachments,
  ).toHaveLength(1);
  expect(await read()).toEqual({ prompt: null });
  await turn('four with a report', true);
  expect((await read()).prompt?.milestone).toBe(3);
});

it('opens the repository instead when GitHub refuses the star', async () => {
  starResponse = 403;
  await db.query(
    `INSERT INTO github_star_prompts(identity_id,replies,reached_milestone,reached_at,last_win_at)
     VALUES($1,3,3,now()-interval '1 minute',now())`,
    [H],
  );
  expect((await read()).prompt?.milestone).toBe(3);
  expect(await answer('star', 3)).toEqual({
    outcome: 'open',
    url: 'https://github.com/Beeline-Work/beeline',
  });
  expect(await read()).toEqual({ prompt: null });
});

it('waits for the next milestone after Not now and stops for good after close', async () => {
  await db.query(
    `INSERT INTO github_star_prompts(identity_id,replies,reached_milestone,reached_at,last_win_at)
     VALUES($1,29,3,now()-interval '1 hour',now())`,
    [H],
  );
  expect((await read()).prompt?.milestone).toBe(3);
  expect(await answer('later', 3)).toEqual({ outcome: 'later' });
  expect(await read()).toEqual({ prompt: null });

  const thirtieth = await turn('thirty');
  expect(await read()).toEqual({ prompt: null });
  await phone.execute('reactToMessage', { roomId: R, messageId: thirtieth, emoji: '👍' }, H);
  expect((await read()).prompt?.milestone).toBe(30);

  expect(await answer('dismiss', 30)).toEqual({ outcome: 'dismissed' });
  await db.query(
    `UPDATE github_star_prompts SET replies=299,reached_milestone=300,last_win_at=now()+interval '1 second'`,
  );
  expect(await read()).toEqual({ prompt: null });
});

it('stays hidden mid-conversation, after a failed turn, and once already starred', async () => {
  await db.query(
    `INSERT INTO github_star_prompts(identity_id,replies,reached_milestone,reached_at,last_win_at)
     VALUES($1,3,3,now()-interval '1 hour',now())`,
    [H],
  );
  expect((await read()).prompt?.milestone).toBe(3);

  await phone.execute('sendRoomMessage', { roomId: R, text: 'one more thing' }, H);
  expect(await read()).toEqual({ prompt: null });
  await db.query(`UPDATE messages SET created_at=created_at-interval '1 minute'`);
  expect((await read()).prompt?.milestone).toBe(3);

  await db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'failed-turn',$2,'failed')`,
    [R, A],
  );
  expect(await read()).toEqual({ prompt: null });
  await db.query(`DELETE FROM agent_turns WHERE request_id='failed-turn'`);

  starred = true;
  expect(await read()).toEqual({ prompt: null });
  starred = false;
  // GitHub said starred once: the card is closed for good.
  expect(await read()).toEqual({ prompt: null });
});

it('counts only replies to a person, never cards', async () => {
  await turn('counted');
  await phone.execute('sendRoomMessage', { roomId: R, text: '@hoots card please' }, H);
  const command = (await daemon.execute('getAgentCommands', { roomId: R }, A)).commands.at(
    -1,
  ) as AgentCommand;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: R, commandId: command.id, generationId: 'g1' },
    A,
  );
  await daemon.execute(
    'postRoomMessage',
    {
      roomId: R,
      requestId: command.turnRequestId,
      generationId: 'g1',
      text: 'a card',
      presentation: 'card',
    },
    A,
  );
  expect(
    (await db.query<{ replies: number }>(`SELECT replies FROM github_star_prompts`)).rows,
  ).toEqual([{ replies: 1 }]);
});
