import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { vaultSaveRequest } from '@beeline/api-contract/daemon';
import { vaultSaveHttp } from './vault-save-http.js';
import { VaultSaveRelay } from './vault-save-relay.js';
import { storeVaultSubmission, type VaultSaveSubmission } from '../../body/src/vault-save.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import type { TokenAuth } from './auth.js';
import { systemLine } from './system-line.js';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a'.repeat(64),
  OWNER = 'b'.repeat(64),
  OTHER = 'c'.repeat(64);
const SECRET = 'throwaway-vault-secret-sentinel-92642';
const metadata = vaultSaveRequest({
  service: 'test',
  label: 'throwaway',
  purpose: 'Test the private card path',
  fields: [{ name: 'password', label: 'Password', secret: true }],
  allowedHosts: ['example.com'],
  authStrategy: 'api_key',
});
const snapshot = await (async () => {
  const db = new PgliteDatabase();
  try {
    await migrate(db);
    return await db.snapshot();
  } finally {
    await db.close();
  }
})();

let db: PgliteDatabase, server: Server, relay: VaultSaveRelay, cardId: string, origin: string;
let logged: unknown[];
beforeEach(async () => {
  logged = [];
  for (const method of ['log', 'warn', 'error', 'info'] as const)
    vi.spyOn(console, method).mockImplementation((...args) => {
      logged.push(args);
    });
  db = PgliteDatabase.fromSnapshot(snapshot);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent'),($2,'human','Owner'),($3,'human','Other')`,
    [AGENT, OWNER, OTHER],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Vault test')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Vault test')`, [
    ROOM,
    WORKSPACE,
  ]);
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,harness,machine_name) VALUES($1,$2,'codex','squire')`,
    [AGENT, OWNER],
  );
  for (const person of [AGENT, OWNER, OTHER])
    for (const room of [null, ROOM])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, room, person],
      );
  const line = await systemLine(db, {
    roomId: ROOM,
    subject: { kind: 'agent', id: AGENT, name: 'Agent' },
    verb: 'wants a vault entry',
    presentation: 'card',
    cardType: 'vault-save',
    card: {
      ...metadata,
      agentId: AGENT,
      ownerId: OWNER,
      ownerName: 'Owner',
      status: 'pending',
      originCommandId: 'missing-test-command',
    },
  });
  cardId = line.id;
  relay = new VaultSaveRelay();
  const live = new LiveHub();
  const auth = {
    authenticatePhone: async (token: string) =>
      token === 'owner'.repeat(8) ? OWNER : token === 'other'.repeat(8) ? OTHER : null,
    authenticateDaemon: async (token: string) => (token === 'helper'.repeat(8) ? AGENT : null),
  } as unknown as TokenAuth;
  const dependencies = {
    auth,
    database: db,
    live,
    phone: new PhoneService(db, 'http://test', undefined, undefined, live),
  };
  server = createServer((request, response) => {
    void vaultSaveHttp(request, response, dependencies, relay);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const submit = (token = 'owner', roomId = ROOM) =>
  fetch(`${origin}/v1/vault-save/submit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.repeat(8)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, cardId, values: { password: SECRET } }),
  });

it('saves through HTTP and the private helper path, exposes metadata, and persists/logs no values', async () => {
  const stored = vi.fn(async (tool: string, args: Record<string, unknown>) => {
    expect(tool).toBe('store_credential');
    expect(args.fields).toEqual({ password: SECRET });
    return { reference: 'vault://test/throwaway', value: SECRET, fields: { password: SECRET } };
  });
  relay.attach(AGENT, (frame) => {
    void storeVaultSubmission(frame as unknown as VaultSaveSubmission, stored).then((answer) =>
      fetch(`${origin}/v1/vault-save/answer`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'helper'.repeat(8)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ attemptId: frame.attemptId, answer }),
      }),
    );
    return true;
  });
  expect(await (await submit()).json()).toMatchObject({
    status: 'saved',
    card: { status: 'saved' },
  });
  expect(await (await submit()).json()).toMatchObject({
    status: 'saved',
    card: { status: 'saved' },
  });
  expect(stored).toHaveBeenCalledTimes(1);
  const saved = (
    await db.query<{ card: Record<string, unknown> }>(`SELECT card FROM messages WHERE id=$1`, [
      cardId,
    ])
  ).rows[0]!.card;
  expect(saved).toMatchObject({ status: 'saved', reference: 'vault://test/throwaway' });
  const tables = await db.query<{
    name: string;
  }>(`SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) name
    FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
  for (const { name } of tables.rows)
    expect(
      (await db.query(`SELECT 1 FROM ${name} row WHERE row::text LIKE '%'||$1||'%'`, [SECRET]))
        .rows,
      name,
    ).toEqual([]);
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

it('refuses another Room member and drops values when the helper is offline', async () => {
  const called = vi.fn(() => true);
  const detach = relay.attach(AGENT, called);
  expect((await submit('other')).status).toBe(403);
  expect(called).not.toHaveBeenCalled();
  detach();
  expect(await (await submit()).json()).toEqual({ status: 'retry' });
  expect(
    (
      await db.query<{ card: { status: string } }>(`SELECT card FROM messages WHERE id=$1`, [
        cardId,
      ])
    ).rows[0]!.card.status,
  ).toBe('pending');
});

it('does not expose upstream secret-bearing errors from the helper', async () => {
  const frame: VaultSaveSubmission = {
    attemptId: 'test',
    cardId,
    roomId: ROOM,
    request: metadata,
    values: { password: SECRET },
  };
  expect(
    await storeVaultSubmission(frame, async () => {
      throw new Error(SECRET);
    }),
  ).toEqual({ status: 'retry' });
  expect(frame.values).toEqual({});
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

it('keeps an unanswered submission in memory only and drops it on timeout or disconnect', async () => {
  let frame: Record<string, unknown> | undefined;
  const detach = relay.attach(AGENT, (event) => {
    frame = event;
    return true;
  });
  const values = { password: SECRET };
  const answer = relay.submit(AGENT, cardId, ROOM, metadata, values, 25);
  expect(frame?.type).toBe('vault-save');
  detach();
  expect(await answer).toEqual({ status: 'retry' });
  expect(values).toEqual({});
});

it('abandons a phone submission on abort and erases its in-memory values', async () => {
  const sent = vi.fn(() => true);
  relay.attach(AGENT, sent);
  const controller = new AbortController();
  const values = { password: SECRET };
  const answer = relay.submit(AGENT, cardId, ROOM, metadata, values, 65_000, controller.signal);
  expect(sent).toHaveBeenCalledOnce();
  controller.abort();
  expect(await answer).toEqual({ status: 'retry' });
  expect(values).toEqual({});
});

it('accepts only names at the agent boundary and masks password fields', () => {
  expect(() => vaultSaveRequest({ ...metadata, value: SECRET })).toThrow();
  expect(() =>
    vaultSaveRequest({
      ...metadata,
      fields: [{ name: 'password', label: 'Password', secret: false }],
    }),
  ).toThrow();
  expect(() =>
    vaultSaveRequest({
      ...metadata,
      fields: [{ name: 'cvv', label: 'Security code', secret: true }],
    }),
  ).toThrow();
});

it('serializes two simultaneous submissions and rejects the second before reaching Squire', async () => {
  let finish: (() => void) | undefined;
  relay.attach(AGENT, (frame) => {
    finish = () =>
      relay.answer(AGENT, frame.attemptId, {
        status: 'saved',
        reference: 'vault://test/concurrent',
      });
    return true;
  });
  const first = submit();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((await submit()).status).toBe(409);
  finish!();
  expect(await (await first).json()).toMatchObject({ status: 'saved' });
});

it('routes to the server holding the helper without sending values through PostgreSQL', async () => {
  vi.stubEnv('FLY_MACHINE_ID', '0123456789abcd');
  await db.query(
    `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'proof','abcdefabcdefab:process')`,
    [AGENT],
  );
  const response = await submit();
  expect(response.status).toBe(307);
  expect(response.headers.get('fly-replay')).toBe('instance=abcdefabcdefab;timeout=5s');
  expect(
    (
      await db.query<{ card: { status: string } }>(`SELECT card FROM messages WHERE id=$1`, [
        cardId,
      ])
    ).rows[0]!.card.status,
  ).toBe('pending');
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

it('drops offline values immediately, including when no helper ever receives a frame', async () => {
  const values = { password: SECRET };
  expect(await relay.submit(AGENT, cardId, ROOM, metadata, values)).toEqual({ status: 'retry' });
  expect(values).toEqual({});
});

it('saves in a corner using inherited parent membership without copied membership rows', async () => {
  const cornerId = '33333333-3333-4333-8333-333333333333';
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Vault corner',$3)`,
    [cornerId, WORKSPACE, ROOM],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Vault proof','{}')`,
    [cornerId, AGENT],
  );
  const line = await systemLine(db, {
    roomId: cornerId,
    subject: { kind: 'agent', id: AGENT, name: 'Agent' },
    verb: 'wants a vault entry',
    presentation: 'card',
    cardType: 'vault-save',
    card: {
      ...metadata,
      agentId: AGENT,
      ownerId: OWNER,
      ownerName: 'Owner',
      status: 'pending',
      originCommandId: 'missing-test-command',
    },
  });
  cardId = line.id;
  expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1`, [cornerId])).rows).toEqual(
    [],
  );
  relay.attach(AGENT, (frame) => {
    queueMicrotask(() =>
      relay.answer(AGENT, frame.attemptId, { status: 'saved', reference: 'vault://test/corner' }),
    );
    return true;
  });
  expect(await (await submit('owner', cornerId)).json()).toMatchObject({ status: 'saved' });
});

it('posts the value-free agent tool card and wakes its requesting command with saved names only', async () => {
  const sourceId = 'd'.repeat(64);
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Post a vault card')`,
    [sourceId, ROOM, OWNER],
  );
  const parent = await createAgentCommand(db, {
    roomId: ROOM,
    agentId: AGENT,
    sourceMessageId: sourceId,
    reason: 'human_tag',
    turnRequestId: sourceId,
  });
  await claimAgentCommand(db, ROOM, AGENT, parent!.id, 'vault-source');
  const daemon = new DaemonService(db, new LiveHub());
  const toolInput = {
    ...metadata,
    roomId: ROOM,
    requestId: sourceId,
    generationId: 'vault-source',
    taskId: parent!.root_command_id,
  };
  const posted = await daemon.execute('postVaultSaveCard', toolInput, AGENT);
  cardId = posted.id;
  relay.attach(AGENT, (frame) => {
    queueMicrotask(() =>
      relay.answer(AGENT, frame.attemptId, { status: 'saved', reference: 'vault://test/wake' }),
    );
    return true;
  });
  expect(await (await submit()).json()).toMatchObject({ status: 'saved' });
  const wake = (
    await db.query<{ parent_command_id: string; root_source_message_id: string; text: string }>(
      `SELECT command.parent_command_id,command.root_source_message_id,message.text FROM agent_commands command
     JOIN messages message ON message.id=command.source_message_id WHERE command.reason='vault_saved'`,
    )
  ).rows[0];
  expect(wake).toMatchObject({ parent_command_id: parent!.id, root_source_message_id: sourceId });
  expect(wake?.text).toContain('vault://test/wake');
  expect(wake?.text).toContain('fields: password');
  expect(wake?.text).not.toContain(SECRET);
});
