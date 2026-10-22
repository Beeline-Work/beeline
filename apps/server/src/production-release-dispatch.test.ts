import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { productionReleaseDispatch } from './production-release-dispatch.js';

const db = new PgliteDatabase();
const room = '22222222-2222-4222-8222-222222222222';
const agent = 'a'.repeat(64);
const human = 'b'.repeat(64);
const input = { roomId: room, requestId: 'request', generationId: 'generation', inputs: { release_version: 'v0.1.94', selection: 'server' } };
beforeAll(async () => {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Jellybean','jellybean'),($2,'human','Owner','owner')`, [agent, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES('11111111-1111-4111-8111-111111111111','Hive')`);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES('11111111-1111-4111-8111-111111111111',$1,'owner')`, [human]);
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
    expect(inputs.selection).toBe('server');
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

it('requires a current workspace owner or admin human command', async () => {
  const dispatch = vi.fn();
  await db.query(`UPDATE memberships SET role='member' WHERE identity_id=$1`, [human]);
  try {
    await expect(productionReleaseDispatch(db, agent, input, dispatch)).rejects.toThrow(/owner or admin/);
    await db.query(`UPDATE memberships SET role='admin' WHERE identity_id=$1`, [human]);
    await productionReleaseDispatch(db, agent, input, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [human]);
    await expect(productionReleaseDispatch(db, agent, input, dispatch)).rejects.toThrow(/owner or admin/);
  } finally {
    await db.query(`UPDATE memberships SET role='owner',removed_at=NULL WHERE identity_id=$1`, [human]);
  }
});

it('retains the request receipt when GitHub refuses, without claiming success', async () => {
  await expect(productionReleaseDispatch(db, agent, input, async () => { throw new Error('already queued'); })).rejects.toThrow('already queued');
  const records = await db.query<{ text: string }>(`SELECT text FROM messages WHERE text LIKE 'Production release dispatch requested:%'`);
  expect(records.rows.length).toBe(3);
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
    const child = spawn(process.execPath, [script, '-f', 'release_version=v0.1.94', '-f', 'selection=server'], {
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
    expect(dispatched[0]!.selection).toBe('server');
    const receipt = (await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [provenance.auditMessageId])).rows[0];
    expect(receipt?.text).toContain('human-command');
    console.log('Demonstrated release-dispatch-attribution: operator command → daemon active-turn authority → persisted Room receipt + GitHub attribution (provider mocked, no production dispatch)');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('R-RELEASE-CARD: built MCP tool dispatches through the daemon with a receipt and zero grants or cards', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { DaemonService } = await import('./daemon-service.js');
  const { LiveHub } = await import('./live.js');
  const dispatch = vi.fn(async () => {});
  const constructorArgs: ConstructorParameters<typeof DaemonService> = [db, new LiveHub()];
  constructorArgs[22] = { dispatchProductionRelease: dispatch } as unknown as import('./github-operations.js').GitHubOperations;
  const service = new DaemonService(...constructorArgs);
  const operations: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      operations.push(request.url!);
      expect(request.url).toBe('/v1/daemon/operations/dispatchRoomWorkflow');
      expect(request.headers.authorization).toBe('Bearer fixture-token');
      let body = '';
      for await (const chunk of request) body += chunk;
      const result = await service.execute('dispatchRoomWorkflow', JSON.parse(body), agent);
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(403).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'release-mcp-proof-'));
  const executable = join(dir, 'release-mcp.mjs');
  const { build } = await import('esbuild');
  await build({
    entryPoints: [fileURLToPath(new URL('../../body/src/read-only-mcp.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: executable, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  });
  const grantCount = async () => (await db.query<{ count: number }>(`SELECT count(*)::int count FROM agent_grants`)).rows[0]!.count;
  const messages = async () => (await db.query<{ count: number }>(`SELECT count(*)::int count FROM messages`)).rows[0]!.count;
  const before = { grants: await grantCount(), messages: await messages() };
  try {
    const context = join(dir, 'turn.json');
    await writeFile(context, JSON.stringify(input));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const run = async () => {
      const child = spawn(process.execPath, [executable], {
        env: { ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${port}`,
          BEELINE_DAEMON_TOKEN: 'fixture-token', BEELINE_DAEMON_AGENT_ID: agent, BEELINE_TURN_CONTEXT_FILE: context },
      });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dispatch_release', arguments: {} } }) + '\n');
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      expect(errors).not.toContain('ERR_MODULE');
      expect(code).toBe(0);
      return JSON.parse(output.trim());
    };
    const result = await run();
    expect(result.result.isError).not.toBe(true);
    const receiptId = JSON.parse(result.result.content[0].text).auditMessageId;
    expect((await db.query(`SELECT id FROM messages WHERE id=$1 AND text LIKE 'Production release dispatch requested:%'`, [receiptId])).rows).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledOnce();
    await db.query(`UPDATE agent_commands SET root_source_message_id='missing' WHERE id='command'`);
    const refused = await run();
    expect(refused.result.isError).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(operations).toHaveLength(2);
    expect(await grantCount()).toBe(before.grants);
    expect(await messages()).toBe(before.messages + 1);

    const { AgentScheduleLoop } = await import('./agent-schedules.js');
    const scheduleLoop = new AgentScheduleLoop(db);
    await expect(service.execute('createAgentSchedule', {
      roomId: room, requestId: input.requestId, generationId: 'stale',
      prompt: 'Unauthorized schedule', cadence: { kind: 'interval', everyMinutes: 60 },
    }, agent)).rejects.toThrow(/authority rejected/);
    expect((await db.query(`SELECT id FROM agent_schedules WHERE message='Unauthorized schedule'`)).rows).toHaveLength(0);
    const scheduledRun = async (humanRoot: boolean, edited = false, legacy = false) => {
      await db.query(`UPDATE agent_commands SET root_source_message_id=$1 WHERE id='command'`, [humanRoot && !legacy ? 'human-command' : 'missing']);
      const saved = await service.execute('createAgentSchedule', {
        roomId: room, requestId: input.requestId, generationId: input.generationId,
        prompt: 'Run the explicitly commanded nightly production release with dispatch_release.',
        cadence: { kind: 'cron', expression: '0 2 * * *', timeZone: 'America/New_York' }, maxRuns: 1,
      }, agent);
      if (legacy) {
        await db.query(`UPDATE agent_commands SET root_source_message_id='human-command' WHERE id='command'`);
        await service.execute('updateAgentSchedule', {
          roomId: room, requestId: input.requestId, generationId: input.generationId,
          scheduleId: saved.scheduleId, title: 'Nightly release',
        }, agent);
      }
      if (edited) await db.query(`UPDATE agent_commands SET root_source_message_id='missing' WHERE id='command'`);
      if (edited) await service.execute('updateAgentSchedule', {
        roomId: room, requestId: input.requestId, generationId: input.generationId,
        scheduleId: saved.scheduleId, prompt: 'Run a different release task.',
      }, agent);
      const authorization = (await db.query<{ human_command_message_id: string | null }>(
        `SELECT human_command_message_id FROM agent_schedules WHERE id=$1`, [saved.scheduleId],
      )).rows[0]!;
      expect(authorization.human_command_message_id).toBe(humanRoot && !edited ? 'human-command' : null);
      expect((await db.query(`SELECT id FROM messages WHERE id=$1`, [saved.scheduleId])).rows).toHaveLength(0);
      await db.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 second' WHERE id=$1`, [saved.scheduleId]);
      expect(await scheduleLoop.runOnce()).toBe(1);
      const commands = (await db.query<{ id: string; root_source_message_id: string }>(
        `SELECT command.id,command.root_source_message_id FROM agent_commands command
         JOIN messages wake ON wake.id=command.source_message_id
         WHERE wake.card->'trigger'->>'scheduleId'=$1 AND command.reason='schedule'`, [saved.scheduleId],
      )).rows;
      expect(commands).toHaveLength(1);
      const command = commands[0]!;
      if (humanRoot && !edited) expect(command.root_source_message_id).toBe('human-command');
      else expect(command.root_source_message_id).not.toBe('human-command');
      await db.query(`UPDATE agent_commands SET state='claimed',generation_id='scheduled-generation' WHERE id=$1`, [command.id]);
      const scheduledContext = (await db.query<{ turn_request_id: string }>(`SELECT turn_request_id FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!;
      await writeFile(context, JSON.stringify({ roomId: room, requestId: scheduledContext.turn_request_id, generationId: 'scheduled-generation' }));
      const beforeDispatch = await messages();
      const result = await run();
      expect(result.result.isError === true).toBe(!humanRoot || edited);
      expect(await messages()).toBe(beforeDispatch + (humanRoot && !edited ? 1 : 0));
      if (humanRoot && !edited) {
        const auditId = JSON.parse(result.result.content[0].text).auditMessageId;
        const audit = (await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [auditId])).rows[0]!;
        expect(audit.text).toContain('"humanCommandMessageId":"human-command"');
      }
      expect(await grantCount()).toBe(before.grants);
    };
    await scheduledRun(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await scheduledRun(false);
    await scheduledRun(true, true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await scheduledRun(true, false, true);
    expect(dispatch).toHaveBeenCalledTimes(3);

    console.log('Demonstrated R-RELEASE-CARD: built dispatch_release → authenticated daemon → committed audit receipt + one stub dispatch, zero grants/cards; scheduled human provenance accepted after schedule expiry; unapproved or edited schedules refused. No production release.');
  } finally {
    await db.query(`UPDATE agent_commands SET root_source_message_id='human-command' WHERE id='command'`);
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
