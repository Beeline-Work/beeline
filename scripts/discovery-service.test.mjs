/** Exercise real local MCP -> service -> persisted schedule and artifact paths, without a model. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, validateNerdProfile, prepareCaseFixtures, assertIsolatedDiscoveryDirectory, isDiscoveryInfrastructureRefusal } from './discovery-live.mjs';
test('safe actions persist and clean up; unsafe call is only recorded', { timeout: 60000 }, async () => {
    const f = await fixture();
    const configured = (await f.database.query(`SELECT harness,selected_model,selected_effort FROM agents`)).rows[0];
    assert.deepEqual(configured, { harness: 'cursor', selected_model: 'grok-4.7-xhigh', selected_effort: null });
    const root = await mkdtemp(join(tmpdir(), 'discovery-service-'));
    const client = new Client({ name: 'discovery-controller', version: '1.0.0' });
    try {
        const identities = await f.database.query(`SELECT id,kind FROM identities WHERE handle IN ('nerd','fixture-owner')`);
        const agent = identities.rows.find((r) => r.kind === 'agent').id;
        const human = identities.rows.find((r) => r.kind === 'human').id;
        const room = randomUUID();
        const workspace = (await f.database.query(`SELECT id FROM workspaces WHERE name='Discovery evaluation'`)).rows[0].id;
        await f.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Test actions')`, [room, workspace]);
        await f.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, room, human, agent]);
        const attachmentBindings = await prepareCaseFixtures(f, { id: 'earlier-file' }, room);
        const workflowBindings = await prepareCaseFixtures(f, { id: 'workflow-read' }, room);
        const messageId = createHash('sha256').update(room).digest('hex');
        await f.phone.execute('sendRoomMessage', { roomId: room, messageId, text: '@nerd Create and remove a test schedule; post a test file.' }, human);
        const command = (await f.database.query(`SELECT id,turn_request_id FROM agent_commands WHERE room_id=$1 AND source_message_id=$2 AND state='pending'`, [room, messageId])).rows[0];
        const generation = randomUUID();
        await f.daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: generation }, agent);
        const context = join(root, 'turn.json');
        await writeFile(context, JSON.stringify({ roomId: room, requestId: command.turn_request_id, generationId: generation }));
        const trace = join(root, 'trace.jsonl');
        await writeFile(trace, '');
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('scripts/discovery-mcp.mjs'), resolve('apps/body/dist/read-only-mcp.js'), trace, room], env: {
                PATH: process.env.PATH, HOME: root, BEELINE_TURN_CONTEXT_FILE: context, BEELINE_MCP_SURFACE: 'agent',
                BEELINE_DAEMON_BASE_URL: f.origin, BEELINE_DAEMON_TOKEN: f.daemonToken, BEELINE_DAEMON_AGENT_ID: agent,
                BEELINE_DAEMON_ROOM_ID: room, BEELINE_DAEMON_WORKSPACE_ID: workspace, BEELINE_ATTACH_ROOT: root, BEELINE_ATTACH_SCRATCH_ROOT: root,
                BEELINE_OPERATOR_HOME: root,
            } }));
        for (const args of [{text:'Local refusal: I cannot impersonate System.'}, {address:room,text:'Explicit local refusal.'}]) {
            const reply = await client.callTool({ name: 'post', arguments: args });
            assert.ok(!reply.isError, JSON.stringify(reply));
            assert.doesNotMatch(JSON.stringify(reply), /intended call recorded/);
            assert.equal((await f.database.query(`SELECT count(*)::int AS count FROM messages WHERE room_id=$1 AND author_id=$2 AND text=$3`, [room, agent, args.text])).rows[0].count, 1);
        }
        const outside = await client.callTool({ name: 'post', arguments: { address: randomUUID(), text: 'Forbidden outside destination' } });
        assert.match(JSON.stringify(outside), /intended call recorded/);
        assert.equal((await f.database.query(`SELECT count(*)::int AS count FROM messages WHERE text='Forbidden outside destination'`)).rows[0].count, 0);
        const usage = await client.callTool({name:'read',arguments:{facet:'usage'}});
        assert.ok(!usage.isError,JSON.stringify(usage));
        assert.match(JSON.stringify(usage),/Fixture plan/);
        const members = await client.callTool({ name: 'read', arguments: { facet: 'members' } });
        assert.equal(members.isError, undefined, JSON.stringify(members));
        const memory = await client.callTool({ name: 'search', arguments: { scope: 'memory', query: 'absent fixture fact', limit: 5 } });
        assert.ok(!memory.isError, JSON.stringify(memory));
        const attachment = await client.callTool({ name: 'read', arguments: { facet: 'attachment', messageId: attachmentBindings['fixture-message'], attachmentId: attachmentBindings['fixture-attachment'] } });
        assert.ok(!attachment.isError, JSON.stringify(attachment));
        const saved = JSON.parse(attachment.content.find(block => block.type === 'text').text);
        assert.equal(await readFile(saved.path, 'utf8'), 'company,amount\nExample Supplies,42\n');
        const workflow = await client.callTool({ name: 'app_tool', arguments: { app: 'beeline:workflow', tool: 'read', args: { runId: workflowBindings['fixture-run'] } } });
        assert.ok(!workflow.isError, JSON.stringify(workflow));
        assert.match(JSON.stringify(workflow), /approval/);
        const created = await client.callTool({ name: 'wake', arguments: { action: 'create', trigger: 'schedule', title: 'Eval cleanup', cadence: { kind: 'interval', everyMinutes: 10 }, prompt: 'A local fixture reminder' } });
        assert.ok(!created.isError, JSON.stringify(created));
        const schedules = await f.database.query(`SELECT id FROM agent_schedules WHERE room_id=$1 AND workflow_run IS NULL`, [room]);
        assert.equal(schedules.rows.length, 1, JSON.stringify(created));
        const deleted = await client.callTool({ name: 'wake', arguments: { action: 'delete', trigger: 'schedule', scheduleId: schedules.rows[0].id } });
        assert.ok(!deleted.isError, JSON.stringify(deleted));
        assert.equal((await f.database.query(`SELECT id FROM agent_schedules WHERE room_id=$1 AND workflow_run IS NULL`, [room])).rows.length, 0);
        const artifact = join(root, 'hello.txt');
        await writeFile(artifact, 'hello');
        const posted = await client.callTool({ name: 'post_artifact', arguments: { path: artifact, mime: 'text/plain', title: 'Fixture text' } });
        assert.ok(!posted.isError, JSON.stringify(posted));
        const objects = await f.database.query(`SELECT id,mime FROM objects WHERE owner_id=$1`, [agent]);
        assert.deepEqual(objects.rows.map((r) => r.mime), ['text/plain']);
        const downloaded = await fetch(`${f.origin}/v1/media/${objects.rows[0].id}`);
        assert.equal(downloaded.status, 200);
        assert.equal(await downloaded.text(), 'hello');
        const game = join(root, 'game.html');
        await writeFile(game, '<!doctype html><button onclick="this.textContent=Number(this.textContent)+1">0</button>');
        const playable = await client.callTool({ name: 'post_artifact', arguments: { path: game, mime: 'application/vnd.beeline.game+html', title: 'Tap game' } });
        const schemas = await client.listTools();
        const supportsGame = JSON.stringify(schemas.tools.find((t) => t.name === 'post_artifact').inputSchema).includes('application/vnd.beeline.game+html');
        // Keep the as-is schema gap observable; this corner does not fix tool text.
        assert.equal(Boolean(playable.isError), !supportsGame, JSON.stringify(playable));
        assert.equal((await f.database.query(`SELECT id FROM objects WHERE owner_id=$1 AND mime=$2`, [agent, 'application/vnd.beeline.game+html'])).rows.length, supportsGame ? 1 : 0);
        const setup=await client.callTool({name:'connect',arguments:{mode:'ensure',service:'Gmail',reason:'Fixture evaluation',continuation:'Search the fixture mailbox.'}});
        assert.match(JSON.stringify(setup),/intended call recorded/);
        // This operation never crosses the forwarding boundary, including on a repo-less Room.
        const intended = await client.callTool({ name: 'merge_corner', arguments: { address: 'fixture-corner' } });
        assert.match(JSON.stringify(intended), /intended call recorded/);
        const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse).filter((e) => e.type === 'call');
        assert.equal(calls.at(-1).intendedOnly, true);
        assert.equal(calls.filter((c) => c.name === 'wake').length, 2);
    }
    finally {
        await client.close();
        await f.close();
        await rm(root, { recursive: true, force: true });
    }
});
test('discovery refuses a checkout and accepts a directory outside Git', async () => {
    await assert.rejects(assertIsolatedDiscoveryDirectory(resolve('.scratch')), /outside every Git checkout/);
    const directory = await mkdtemp(join(tmpdir(), 'discovery-outside-'));
    try { await assertIsolatedDiscoveryDirectory(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
});
test('turn deadlines do not skip the rest of the corpus; provider refusals stop it', () => {
    assert.equal(isDiscoveryInfrastructureRefusal('Harness turn timed out'), false);
    assert.equal(isDiscoveryInfrastructureRefusal('Local Room startup timed out'), true);
    assert.equal(isDiscoveryInfrastructureRefusal('API error (status 402 Payment Required): balance exhausted'), true);
    assert.equal(isDiscoveryInfrastructureRefusal('authentication failed'), true);
    assert.equal(isDiscoveryInfrastructureRefusal(undefined), false);
});
test('Nerd profile must preserve the actual Cursor harness and complete model ID', () => {
    const profile = { agentId: '2310dc4ab514aa3019ebc61d2a4d2e59086cac78a53a7235f1903952ea48c762', harness: 'cursor', model: 'grok-4.7-xhigh', effort: null, soul: { name: 'Nerd', instructions: 'Fixture soul' } };
    assert.equal(validateNerdProfile(profile), profile);
    assert.throws(() => validateNerdProfile({ ...profile, harness: 'grok', model: 'grok-4.7', effort: 'xhigh' }), /current Nerd configuration/);
    assert.throws(() => validateNerdProfile({ ...profile, harness: undefined }), /current Nerd configuration/);
});
