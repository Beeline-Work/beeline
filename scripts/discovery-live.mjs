/** Run Nerd’s configured Cursor harness against a disposable local Beeline service. */
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getPublicKey } from '@beeline/nostr';
import { migrate } from '../apps/server/src/database.ts';
import { MemoryObjectStorage, PgliteDatabase } from '../apps/server/src/test-support.ts';
import { TokenAuth } from '../apps/server/src/auth.ts';
import { PhoneService } from '../apps/server/src/phone-service.ts';
import { DaemonService } from '../apps/server/src/daemon-service.ts';
import { LiveHub } from '../apps/server/src/live.ts';
import { createBeelineServer } from '../apps/server/src/server.ts';
import { ObjectService } from '../apps/server/src/object-service.ts';
import { prepareRoomAgentHome } from '../apps/body/src/agent-home.ts';
import { DaemonApiClient } from '../apps/body/src/daemon-api-client.ts';
import { runtimeConfigPath } from '../apps/body/src/runtime.ts';
import { ThinDaemonCore } from '../apps/body/src/thin-core.ts';
import { cursorAcpBridgeLaunch } from '../apps/body/src/cursor-acp-bridge.ts';
import { summarize } from './discovery-score.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUMAN = createHash('sha256').update('discovery-fixture-owner').digest('hex');
const MEMBER = createHash('sha256').update('discovery-fixture-member').digest('hex');
const SECRET = new Uint8Array(32).fill(43);
const AGENT = getPublicKey(SECRET);
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function fixture(profile) {
    const database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name,handle,github_subject)
    VALUES($1,'human','Fixture Owner','fixture-owner','discovery-fixture-owner'),($2,'agent','Nerd','nerd',NULL),($3,'human','Fixture Member','fixture-member','discovery-fixture-member')`, [HUMAN, AGENT, MEMBER]);
    await database.query(`INSERT INTO agents(agent_id,owner_id,soul,harness,selected_model,selected_effort,model_catalog)
    VALUES($1,$2,$3::jsonb,'cursor','grok-4.7-xhigh',NULL,'[]'::jsonb)`, [AGENT, HUMAN, JSON.stringify(profile?.soul ?? { name: 'Nerd', instructions: '' })]);
    await database.query(`UPDATE agents SET usage_snapshot=$1::jsonb WHERE agent_id=$2`, [JSON.stringify({ updatedAt: Date.now() / 1000, plan: 'Fixture plan', windows: [{ rateLimitType: 'included_usage', status: 'allowed', utilization: 0.25, resetsAt: Date.now() / 1000 + 604800, updatedAt: Date.now() / 1000 }] }), AGENT]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Discovery evaluation')`, [WORKSPACE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member')`, [WORKSPACE, HUMAN, AGENT, MEMBER]);
    const auth = new TokenAuth(database, async () => ({ subject: 'discovery-fixture-owner', login: 'fixture-owner', name: 'Fixture Owner' }));
    const live = new LiveHub();
    const phone = new PhoneService(database, 'http://placeholder', undefined, undefined, live);
    const storage = new MemoryObjectStorage();
    await storage.listen();
    const daemon = new DaemonService(database, live);
    const server = createBeelineServer({ database, auth, phone, daemon, live,
        mediaMaximumBytes: 8 * 1024 * 1024, objectService: new ObjectService(database, storage.asStorage(), 'http://placeholder') });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const exchange = await auth.createDaemonExchange(AGENT);
    const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exchangeToken: exchange.exchangeToken }) });
    const { daemonToken } = await exchanged.json();
    if (!daemonToken)
        throw new Error('Local daemon authentication failed');
    return { database, phone, origin, daemonToken, daemon, async close() {
            server.closeAllConnections();
            await new Promise((done) => server.close(done));
            await storage.close();
            await database.close();
        } };
}
export async function runCase(f, testCase, directory, options = {}) {
    const room = randomUUID();
    const root = join(directory, testCase.id);
    await mkdir(root, { recursive: true });
    const agentHomeRoot = join(root, 'agent-home');
    await mkdir(join(agentHomeRoot, 'user'), { recursive: true });
    const trace = join(agentHomeRoot, 'user', 'discovery-calls.jsonl');
    await writeFile(trace, '');
    await f.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,$3)`, [room, WORKSPACE, testCase.id]);
    await f.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`, [WORKSPACE, room, HUMAN, AGENT, MEMBER]);
    const operatorHome = options.operatorHome ?? '/home/lunchbox';
    const overlay = await prepareRoomAgentHome({ root: agentHomeRoot, operatorHome, agentKind: 'cursor', sharedSkills: [], grantedHostRoutes: [] });
    const runtime = { version: 2, communityId: WORKSPACE, pairedBy: HUMAN,
        agent: { name: 'Nerd', publicKey: AGENT, secretKeyHex: Buffer.from(SECRET).toString('hex') },
        body: { name: 'Fixture Body', publicKey: getPublicKey(new Uint8Array(32).fill(44)), secretKeyHex: Buffer.from(new Uint8Array(32).fill(44)).toString('hex') },
        rooms: [{ channelId: room, root }], supervisorRoot: directory, agentKind: 'cursor', agentCommand: process.execPath, agentArgs: cursorAcpBridgeLaunch().args,
        agentBinary: 'cursor-agent', mcpBinary: process.execPath, accessPolicy: 'everyone', transport: { kind: 'monolith', baseUrl: f.origin, daemonToken: f.daemonToken } };
    const config = { bwrapPath: '/usr/bin/bwrap', agentKind: 'cursor', agentCommand: process.execPath, agentArgs: [join(ROOT, 'scripts/discovery-launch.mjs')], agentBinary: 'cursor-agent',
        modelSelection: { model: 'grok-4.7-xhigh' }, mcpBinary: process.execPath,
        readonlyMcpCommand: process.execPath, readonlyMcpArgs: [join(ROOT, 'scripts/discovery-mcp.mjs'), join(ROOT, 'apps/body/dist/read-only-mcp.js'), trace],
        agentHomeRoot, sharedSkills: [], operatorHome, workspaceRoot: root,
        agentEnv: { ...overlay, PATH: process.env.PATH, LANG: 'C.UTF-8', USER: process.env.USER, BEELINE_DISCOVERY_TRACE: trace, BEELINE_DISCOVERY_HOME_ROOT: agentHomeRoot },
        autoApprovePermissions: false, accessPolicy: 'everyone' };
    const configPath = runtimeConfigPath(directory, AGENT);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(runtime), { mode: 0o600 });
    const core = new ThinDaemonCore(runtime, configPath, config, { daemonApi: new DaemonApiClient(f.origin, f.daemonToken, AGENT), reconcileHeartbeatMs: 60000 });
    const abort = new AbortController();
    await f.phone.execute('sendRoomMessage', { roomId: room, messageId: createHash('sha256').update(`${room}:request`).digest('hex'), wakes: [AGENT], text: `@nerd ${testCase.request}` }, testCase.requesterRole === 'member' ? MEMBER : HUMAN);
    const queued = await f.database.query(`SELECT state FROM agent_commands WHERE room_id=$1`, [room]);
    if (!queued.rows.length)
        throw new Error('Fixture request did not create an agent command');
    const running = core.run({ pollMs: 100, signal: abort.signal });
    let coreError;
    running.catch((error) => { coreError = error; });
    const observation = { id: testCase.id, room, completed: false, calls: [], text: '', execution: 'local-service' };
    try {
        const readyDeadline = Date.now() + 60000;
        while (!core.activeRoomIds().includes(room)) {
            if (coreError)
                throw coreError;
            if (Date.now() > readyDeadline)
                throw new Error('Local Room startup timed out');
            await sleep(200);
        }
        const deadline = Date.now() + (options.timeoutMs ?? 300000);
        while (Date.now() < deadline) {
            if (coreError)
                throw coreError;
            const turns = await f.database.query(`SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 1`, [room, AGENT]);
            const turn = turns.rows[0];
            if (turn?.status === 'failed')
                throw new Error(turn.failure_reason ?? 'Harness turn failed');
            if (turn?.status === 'complete') {
                observation.completed = true;
                break;
            }
            await sleep(500);
        }
        if (!observation.completed)
            throw new Error('Harness turn timed out');
    }
    catch (error) {
        observation.error = error.message;
    }
    finally {
        abort.abort();
        await running.catch(() => { });
        const events = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        observation.calls = events.filter((e) => e.type === 'call').map((call) => { const response = events.find((e) => e.type === 'result' && e.id === call.id); return { ...call, response: response?.result, succeeded: call.intendedOnly || Boolean(response && !response.error && !response.result?.isError) }; });
        const messages = await f.database.query(`SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message' ORDER BY created_at`, [room, AGENT]);
        observation.text = messages.rows.map((m) => m.text ?? '').join('\n');
        const schedules = await f.database.query(`SELECT id FROM agent_schedules WHERE room_id=$1`, [room]);
        const objects = await f.database.query(`SELECT id,mime FROM objects WHERE owner_id=$1`, [AGENT]);
        observation.effects = { remainingSchedules: schedules.rows.length, objects: objects.rows };
        await f.database.query(`DELETE FROM agent_schedules WHERE room_id=$1`, [room]);
        await f.database.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`, [room, AGENT]);
        await writeFile(join(root, 'observation.json'), JSON.stringify(observation, null, 2) + '\n');
    }
    return observation;
}
export function validateNerdProfile(profile) {
    if (profile && (profile.agentId !== '2310dc4ab514aa3019ebc61d2a4d2e59086cac78a53a7235f1903952ea48c762' || profile.harness !== 'cursor' || profile.model !== 'grok-4.7-xhigh' || profile.effort != null || typeof profile.soul?.instructions !== 'string'))
        throw new Error('Profile must be the current Nerd configuration, not a model substitute');
    return profile;
}
export async function runDiscovery({ out, only, operatorHome, timeoutMs, profilePath } = {}) {
    const profile = profilePath ? JSON.parse(await readFile(profilePath, 'utf8')) : undefined;
    validateNerdProfile(profile);
    const cases = JSON.parse(await readFile(join(ROOT, 'docs/prompts/cases/discovery/corpus.json'), 'utf8'));
    const selected = only ? cases.filter((c) => only.split(',').includes(c.id)) : cases;
    if (!selected.length)
        throw new Error('No matching discovery cases');
    const directory = out ?? await mkdtemp(join(homedir(), 'beeline-discovery-'));
    if (existsSync(join(directory, 'result.json')))
        throw new Error('Use a fresh output directory; existing evidence must not be overwritten');
    await mkdir(directory, { recursive: true });
    const observations = [];
    const sourceHashes = Object.fromEntries(await Promise.all(['scripts/discovery-live.mjs', 'scripts/discovery-launch.mjs', 'scripts/discovery-mcp.mjs', 'scripts/discovery-score.mjs', 'docs/prompts/cases/discovery/corpus.json', 'apps/body/src/beeline-skill.ts', 'apps/body/src/prompt-assembly.ts', 'apps/body/src/minimal-tool-surface.ts', 'apps/body/dist/read-only-mcp.js'].map(async (path) => [path, createHash('sha256').update(await readFile(join(ROOT, path))).digest('hex')])));
    const metadata = { sourceHashes, configurationParity: profile ? { agentId: profile.agentId, profileSha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex') } : 'unverified; smoke only', agent: 'nerd', model: 'grok-4.7-xhigh', effort: null, harness: 'cursor', harnessVersion: execFileSync('cursor-agent', ['--version'], { encoding: 'utf8' }).trim(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), startedAt: new Date().toISOString() };
    const f = await fixture(profile);
    const save = async () => {
        const summary = summarize(selected, observations);
        const judgePrompt = await readFile(join(ROOT, 'docs/prompts/cases/discovery/judge.md'), 'utf8');
        await writeFile(join(directory, 'judge-inputs.json'), JSON.stringify({ prompt: judgePrompt, rubricSha256: createHash('sha256').update(judgePrompt).digest('hex'), cases: selected.filter((c) => c.expected.kind !== 'action').map((c) => ({ caseId: c.id, request: c.request, expected: c.expected, observed: observations.find((o) => o.id === c.id) ?? null })) }, null, 2) + '\n');
        const result = { ...metadata, ...summary, passRate: profile ? summary.passRate : null, observations };
        await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
        return result;
    };
    try {
        for (const testCase of selected) {
            let observed;
            try {
                observed = await runCase(f, testCase, directory, { operatorHome, timeoutMs });
            }
            catch (error) {
                observed = { id: testCase.id, completed: false, calls: [], text: '', error: error.message };
            }
            observations.push(observed);
            const result = await save();
            console.log(`${testCase.id}: ${result.rows.at(observations.length - 1).status}${observed.error ? ` (${observed.error})` : ''}`);
            // Authentication/startup failures are infrastructure gaps, not sixty model failures.
            if (observed.error && (!observed.calls.length || /auth|login|startup/i.test(observed.error)))
                break;
        }
    }
    finally {
        await f.close();
    }
    return save();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const option = (name) => args[args.indexOf(name) + 1];
    if (!args.includes('--run'))
        throw new Error('Use --run deliberately: this spends the owner’s Cursor subscription allowance');
    const result = await runDiscovery({ out: args.includes('--out') ? resolve(option('--out')) : undefined, only: args.includes('--only') ? option('--only') : undefined, profilePath: args.includes('--profile') ? resolve(option('--profile')) : undefined, operatorHome: args.includes('--operator-home') ? resolve(option('--operator-home')) : undefined });
    console.log(`Discovery: ${result.passed}/${result.completed} completed passed; ${result.completed}/${result.total} completed; overall rate ${result.passRate ?? 'unavailable'}`);
    if (result.passRate === null)
        process.exitCode = 1;
}
