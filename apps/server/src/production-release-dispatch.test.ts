import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { productionReleaseDispatch } from './production-release-dispatch.js';

const db = new PgliteDatabase();
const room = '22222222-2222-4222-8222-222222222222';
const agent = 'a'.repeat(64);
const human = 'b'.repeat(64);
const input = { roomId: room, requestId: 'request', generationId: 'generation', inputs: { release_version: 'v0.1.94', retry_attempt: '2' } };
beforeAll(async () => {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Jellybean','jellybean'),($2,'human','Owner','owner')`, [agent, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES('11111111-1111-4111-8111-111111111111','Hive')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,'11111111-1111-4111-8111-111111111111','Release')`, [room]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('human-command',$1,$2,'Release now')`, [room, human]);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state,generation_id)
    VALUES('command',$1,$2,'human-command','request','input','human','command','human-command',0,'claimed','generation')`, [room, agent]);
});
afterAll(() => db.close());

it('release-dispatch-attribution: commits readable server provenance before dispatch and preserves recovery inputs', async () => {
  const dispatch = vi.fn(async (inputs: Record<string, string>) => {
    const provenance = JSON.parse(inputs.dispatched_by!);
    expect(provenance).toMatchObject({ agentId: agent, handle: 'jellybean', place: room, humanCommandMessageId: 'human-command' });
    expect(inputs.release_version).toBe('v0.1.94');
    expect(inputs.retry_attempt).toBe('2');
    const receipt = (await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [provenance.auditMessageId])).rows[0];
    expect(receipt?.text).toContain(inputs.dispatched_by);
    expect(receipt?.text).not.toMatch(/token|secret/i);
  });
  const result = await productionReleaseDispatch(db, agent, input, dispatch);
  expect(result.auditMessageId).toBeTruthy();
  expect(dispatch).toHaveBeenCalledOnce();
});

it('refuses missing agent identity, stale turns, nonhuman provenance and forged attribution before dispatch', async () => {
  const dispatch = vi.fn();
  await expect(productionReleaseDispatch(db, human, input, dispatch)).rejects.toThrow(/agent identity/);
  await expect(productionReleaseDispatch(db, agent, { ...input, generationId: 'stale' }, dispatch)).rejects.toThrow(/authority rejected/);
  await expect(productionReleaseDispatch(db, agent, { ...input, inputs: { dispatched_by: 'forged' } }, dispatch)).rejects.toThrow(/Invalid/);
  await db.query(`UPDATE agent_commands SET root_source_message_id='missing' WHERE id='command'`);
  try {
    await expect(productionReleaseDispatch(db, agent, input, dispatch)).rejects.toThrow(/human command/);
  } finally { await db.query(`UPDATE agent_commands SET root_source_message_id='human-command' WHERE id='command'`); }
  expect(dispatch).not.toHaveBeenCalled();
});

it('retains the request receipt when GitHub refuses, without claiming success', async () => {
  await expect(productionReleaseDispatch(db, agent, input, async () => { throw new Error('already queued'); })).rejects.toThrow('already queued');
  const records = await db.query<{ text: string }>(`SELECT text FROM messages WHERE text LIKE 'Production release dispatch requested:%'`);
  expect(records.rows.length).toBe(2);
  expect(records.rows.every(row => !row.text.includes('succeeded'))).toBe(true);
});

it('demonstrates the operator executable through authenticated daemon dispatch to a readable receipt', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { DaemonService } = await import('./daemon-service.js');
  const { LiveHub } = await import('./live.js');
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'member')`, [room, agent]);
  const dispatched: Record<string, string>[] = [];
  const constructorArgs: ConstructorParameters<typeof DaemonService> = [db, new LiveHub()];
  constructorArgs[22] = {
    dispatchProductionRelease: async (_room: string, inputs: Record<string, string>) => { dispatched.push(inputs); },
  } as unknown as import('./github-operations.js').GitHubOperations;
  const service = new DaemonService(...constructorArgs);
  const server = createServer(async (request, response) => {
    try {
      expect(request.url).toBe('/v1/daemon/operations/dispatchRoomWorkflow');
      expect(request.headers.authorization).toBe('Bearer fixture-token');
      let body = '';
      for await (const chunk of request) body += chunk;
      const result = await service.execute('dispatchRoomWorkflow', JSON.parse(body), agent);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'release-operator-proof-'));
  try {
    const context = join(dir, 'turn.json');
    await writeFile(context, JSON.stringify(input));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const script = fileURLToPath(new URL('../../../scripts/dispatch-production-release.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, '-f', 'release_version=v0.1.94', '-f', 'retry_attempt=2'], {
      env: { ...process.env, BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${port}`, BEELINE_DAEMON_TOKEN: 'fixture-token',
        BEELINE_DAEMON_AGENT_ID: agent, BEELINE_TURN_CONTEXT_FILE: context },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    expect(output).toMatch(/Production release dispatched. Audit message:/);
    expect(code).toBe(0);
    expect(dispatched).toHaveLength(1);
    const provenance = JSON.parse(dispatched[0]!.dispatched_by!);
    expect(provenance.handle).toBe('jellybean');
    expect(dispatched[0]!.retry_attempt).toBe('2');
    const receipt = (await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [provenance.auditMessageId])).rows[0];
    expect(receipt?.text).toContain('human-command');
    console.log('Demonstrated release-dispatch-attribution: operator command → daemon active-turn authority → persisted Room receipt + GitHub attribution (provider mocked, no production dispatch)');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
