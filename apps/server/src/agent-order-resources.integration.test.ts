import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemIdentity } from './system-line.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimAgentCommand, createAgentCommand, type CommandRow } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { resourceRequester } from './resource-requester.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const ISSUER = 'c'.repeat(64), WORKER = 'd'.repeat(64), DELEGATE = 'e'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService;
let profile: string;

beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES
    ($1,'human','Owner'),($2,'human','Other'),($3,'agent','Issuer'),
    ($4,'agent','Worker'),($5,'agent','Delegate')`, [OWNER, OTHER, ISSUER, WORKER, DELEGATE]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$5)`,
    [ISSUER, WORKER, DELEGATE, OWNER, OTHER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Orders')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Output'),($2,$3,'Private')`, [ROOM, PRIVATE, W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,NULL,identity_id,CASE WHEN identity_id=$2 THEN 'owner' ELSE 'member' END
    FROM unnest($3::text[]) identity_id`, [W, OWNER, [OWNER, OTHER, ISSUER, WORKER, DELEGATE]]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,$2,identity_id,'member' FROM unnest($3::text[]) identity_id`, [W, ROOM, [OWNER, ISSUER, WORKER, DELEGATE]]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,$2,identity_id,'member' FROM unnest($3::text[]) identity_id`, [W, PRIVATE, [OWNER, ISSUER, WORKER, DELEGATE]]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES
    ('source',$1,$3,'Release marker goes last.'),('private',$2,$3,'Release private marker goes last.')`, [ROOM, PRIVATE, OWNER]);
  profile = randomUUID();
  await db.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,canonical_key,body,subject_identity_id,source_room_id,source_message_id,
     audience_kind,confidence,version,created_by_command_id)
    VALUES($1,$2,'human_profile_fact','owner.marker','Owner prefers release marker last.',$3,$4,'source','human_profile',0.9,1,'fixture')`,
    [profile, W, OWNER, ROOM]);
  await db.query(`INSERT INTO workspace_skills
    (id,workspace_id,slug,description,kind,current_version,revision,source_room_id,repository,target_commit)
    VALUES($1,$2,'release','Release workflow','workflow',1,1,$3,'','')`, [randomUUID(), W, ROOM]);
  daemon = new DaemonService(db, new LiveHub(), undefined, undefined, false, undefined,
    false, undefined, undefined, undefined, { enabled: true, live: true });
});
afterEach(async () => { await db.close(); });

async function order(issuer = ISSUER, parent?: CommandRow, agentId = WORKER) {
  return (await createAgentCommand(db, { roomId: ROOM, agentId, sourceMessageId: null,
    reason: 'order', ...(parent ? { parent } : {}), privatePayload: {
      kind: 'order', authorId: issuer, fromRoomId: ROOM, text: 'Find the release marker.',
    } }))!;
}
async function claim(command: CommandRow) {
  await claimAgentCommand(db, ROOM, command.agent_id, command.id, 'generation');
  return { roomId: ROOM, requestId: command.turn_request_id, generationId: 'generation' };
}

// This uses actual command admission and each resource's ordinary authorization,
// rather than injecting a requester into a tool argument.
describe('agent orders act for the issuing owner', () => {
  it.each(['order', 'nested', 'mcp', 'message', 'human'] as const)('%s provenance reaches history, memory, Squire discovery and workflow archive', async shape => {
    let command: CommandRow;
    if (shape === 'human') command = (await createAgentCommand(db, {
      roomId: ROOM, agentId: WORKER, sourceMessageId: 'source', reason: 'human_tag',
    }))!;
    else if (shape === 'mcp') {
      const root = (await createAgentCommand(db, { roomId: ROOM, agentId: ISSUER,
        sourceMessageId: null, reason: 'mcp_call' }))!;
      command = await order(ISSUER, root);
    } else if (shape === 'message') {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('agent-order',$1,$2,'Find the release marker.')`, [ROOM, ISSUER]);
      command = (await createAgentCommand(db, { roomId: ROOM, agentId: WORKER,
        sourceMessageId: 'agent-order', reason: 'agent_tag' }))!;
    } else {
      command = await order();
      if (shape === 'nested') {
        // The intervening agent has another owner; the original issuer wins.
        command = await order(WORKER, command, DELEGATE);
        command = await order(DELEGATE, command);
      }
    }
    const turn = await claim(command);
    expect(await daemon['grantRequester'](command)).toMatchObject({ id: OWNER, kind: 'human' });
    await expect(daemon.execute('getInstitutionalContext', turn, WORKER)).resolves.toHaveProperty('itemIds');
    const history = await daemon.execute('searchInstitutionalHistory', { ...turn, query: 'release marker' }, WORKER);
    expect(history.results.map(row => row.messageId)).toContain('private');
    const memory = await daemon.execute('searchInstitutionalMemory', { ...turn, query: 'marker' }, WORKER);
    expect(memory.results.map(row => row.id)).toContain(profile);
    expect(await daemon.execute('reportInstitutionalMemoryUsed', { ...turn, itemIds: [profile] }, WORKER)).toEqual({ refreshed: 1 });
    const saved = await daemon.execute('saveInstitutionalMemory', { ...turn,
      memoryKind: 'workspace_fact', canonicalKey: 'release.marker', body: 'Release marker goes last.',
      keywords: ['release', 'marker'], sourceMessageIds: ['source'], personAsked: false, confidence: 0.9,
    }, WORKER);
    expect(saved.version).toBe(1);
    const ownFact = await daemon.execute('saveInstitutionalMemory', { ...turn,
      memoryKind: 'human_profile_fact', canonicalKey: 'owner.release', body: 'Owner likes release notes.',
      keywords: ['release'], sourceMessageIds: ['source'], personAsked: false, confidence: 0.9,
    }, WORKER);
    expect((await db.query('SELECT subject_identity_id FROM institutional_memory_items WHERE id=$1', [ownFact.itemId])).rows)
      .toEqual([{ subject_identity_id: OWNER }]);
    expect(await daemon.execute('authorizeResourceCall', { ...turn, target: 'squire', consume: false,
      operation: 'initialize' }, WORKER)).toMatchObject({ allowed: true });
    expect(await daemon.execute('archiveWorkflow', { ...turn, name: 'release' }, WORKER))
      .toEqual({ slug: 'release', archived: true });
  });

  it('uses a foreign issuer’s own owner without exposing the executing owner’s private resources', async () => {
    await db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [ISSUER, OTHER]);
    const command = await order();
    const turn = await claim(command);
    expect(await daemon['grantRequester'](command)).toMatchObject({ id: OTHER });
    const history = await daemon.execute('searchInstitutionalHistory', { ...turn, query: 'marker' }, WORKER);
    expect(history.results.map(row => row.messageId)).not.toContain('private');
    const memory = await daemon.execute('searchInstitutionalMemory', { ...turn, query: 'marker' }, WORKER);
    expect(memory.results.map(row => row.id)).not.toContain(profile);
    expect(await daemon.execute('reportInstitutionalMemoryUsed', { ...turn, itemIds: [profile] }, WORKER))
      .toEqual({ refreshed: 0 });
    await expect(daemon.execute('archiveWorkflow', { ...turn, name: 'release' }, WORKER)).rejects.toThrow('workspace admin');
    // Wallet consent remains requester-bound, even though this worker belongs to Owner.
    expect(await daemon.execute('authorizeResourceCall', { ...turn, target: 'wallet', consume: false }, WORKER))
      .toMatchObject({ allowed: false });
    expect((await db.query('SELECT state FROM workspace_skills WHERE slug=\'release\'')).rows[0]?.state).toBe('active');
  });

  it('starts Squire through the real resource facade only after command authorization', async () => {
    const command = await order();
    const turn = await claim(command);
    const scratch = await mkdtemp(join(tmpdir(), 'beeline-order-facade-'));
    let upstreamCalls = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      if (request.url === '/squire') {
        upstreamCalls++;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { serverInfo: { name: 'Squire fixture' } } }));
        return;
      }
      try {
        response.end(JSON.stringify(await daemon.execute('authorizeResourceCall', input, WORKER)));
      } catch {
        response.writeHead(403);
        response.end(JSON.stringify({ allowed: false }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const contextPath = join(scratch, 'turn.json'), authPath = join(scratch, 'auth.json');
    await writeFile(contextPath, JSON.stringify(turn));
    await writeFile(authPath, JSON.stringify({ baseUrl, daemonToken: 'fixture', turnContextPath: contextPath }));
    const initialize = async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../body/src/resource-mcp-facade.ts', import.meta.url))], {
        env: { ...process.env, BEELINE_RESOURCE_TARGET: 'squire', BEELINE_RESOURCE_AUTH_FILE: authPath,
          BEELINE_RESOURCE_LAUNCH: JSON.stringify({ url: `${baseUrl}/squire` }) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', errors = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { errors += data; });
      const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        expect(await exit, errors).toBe(0);
        return JSON.parse(output);
      } finally { clearTimeout(timeout); child.kill(); }
    };
    try {
      expect(await initialize()).toMatchObject({ result: { serverInfo: { name: 'Squire fixture' } } });
      expect(upstreamCalls).toBe(1);
      await db.query('UPDATE agent_commands SET root_command_id=$2,root_source_message_id=$2 WHERE id=$1', [command.id, 'missing-root']);
      expect(await initialize()).toMatchObject({ error: { code: -32001 } });
      expect(upstreamCalls).toBe(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('preserves System-only resource provenance without widening institutional reads', async () => {
    await ensureSystemIdentity(db);
    const command = await order(SYSTEM_IDENTITY_ID);
    const turn = await claim(command);
    expect(await daemon['grantRequester'](command)).toMatchObject({ id: SYSTEM_IDENTITY_ID });
    await expect(daemon.execute('searchInstitutionalMemory', { ...turn, query: 'marker' }, WORKER))
      .rejects.toThrow('requester authority is unavailable');
    await expect(daemon.execute('searchInstitutionalHistory', { ...turn, query: 'marker' }, WORKER))
      .rejects.toThrow('requester authority is unavailable');
  });

  it('follows agent ownership to a human and terminates ownership cycles', async () => {
    await db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [ISSUER, DELEGATE]);
    const command = await order();
    expect((await resourceRequester(db, command))?.requester.id).toBe(OTHER);
    await db.query('UPDATE agents SET owner_id=$2 WHERE agent_id=$1', [DELEGATE, ISSUER]);
    expect(await resourceRequester(db, command)).toBeUndefined();
  });
});
