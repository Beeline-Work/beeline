import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, migrateData } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { FREE_AGENT_CONNECT_GUIDE, freeAgentConfigFromEnv, freeAgentInstructions } from './free-agents.js';
import { recordAgentConnectedAfterNudge, warnFreeAgentOwner } from './free-agent-warning.js';
import { PhoneService } from './phone-service.js';

const OWNER = 'a'.repeat(64), AGENT = 'b'.repeat(64), OTHER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-10-16';

describe('free agent owner warning', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Fern'),($3,'human','Other')`, [OWNER, AGENT, OTHER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    for (const member of [OWNER, AGENT, OTHER]) await db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, member]);
    await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,state) VALUES($1,$2,$3,'sealed','running')`, [AGENT, WORKSPACE, OWNER]);
  });
  afterEach(async () => { await db.close(); });
  const usage = async (day: string, tokens: number) => {
    await db.query(`INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,$2,$3) ON CONFLICT(owner_id,day) DO UPDATE SET tokens=$3`, [OWNER, day, tokens]);
    await db.query(`DELETE FROM free_agent_events WHERE kind='model_usage' AND detail->>'day'=$1`, [day]);
    await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail,at) VALUES($1,'model_usage',$2::jsonb,($3::date::timestamp AT TIME ZONE 'UTC'))`, [AGENT, JSON.stringify({ day, tokens }), day]);
  };
  const warn = (day = DAY) => warnFreeAgentOwner(db, AGENT, OWNER, day, 1000);

  it('delivers once per UTC day at 80%, privately, through the owner Room read', async () => {
    await usage(DAY, 799);
    await db.query(`UPDATE free_agent_usage SET tokens=1000`);
    await warn();
    expect((await db.query(`SELECT * FROM messages`)).rowCount).toBe(0);
    await usage(DAY, 800);
    await warn();
    await warn();
    const messages = await db.query<{ room_id: string; text: string }>(`SELECT room_id,text FROM messages`);
    expect(messages.rowCount).toBe(1);
    expect(messages.rows[0]!.text).toContain('midnight UTC');
    expect(messages.rows[0]!.text).toContain(`members?communityId=${WORKSPACE}&action=add-agent`);
    const roomId = messages.rows[0]!.room_id;
    const phone = new PhoneService(db, 'https://server.test');
    const view = await phone.readRoom(roomId, OWNER);
    expect(JSON.stringify(view)).toContain("I've used 80%");
    expect(await phone.readRoom(roomId, OTHER)).toBeNull();
    expect((await db.query(`SELECT identity_id FROM memberships WHERE room_id=$1`, [roomId])).rows.map(r => r.identity_id).sort()).toEqual([OWNER, AGENT].sort());
    await usage('2026-10-17', 801);
    await warn('2026-10-17');
    expect((await db.query(`SELECT * FROM messages`)).rowCount).toBe(2);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='allowance_warning'`)).rowCount).toBe(2);
  });

  it('records a non-free agent connected within 24 hours once, excludes old warnings', async () => {
    await usage(DAY, 800);
    await warn();
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, OTHER);
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, OTHER);
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, AGENT);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='agent_connected_after_nudge'`)).rowCount).toBe(1);
    await db.query(`DELETE FROM free_agent_events WHERE kind='agent_connected_after_nudge'`);
    await db.query(`UPDATE free_agent_events SET at=now()-interval '25 hours'`);
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, OTHER);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='agent_connected_after_nudge'`)).rowCount).toBe(0);
  });

  it('records reaching Add agent after a warning as a guide start, without storing codes', async () => {
    const phone = new PhoneService(db, 'https://server.test');
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OWNER);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='guide_started'`)).rowCount).toBe(0);
    await usage(DAY, 800);
    await warn();
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OTHER);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='guide_started'`)).rowCount).toBe(0);
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OWNER);
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OWNER);
    const events = await db.query(`SELECT detail FROM free_agent_events WHERE kind='guide_started'`);
    expect(events.rowCount).toBe(1);
    expect(events.rows[0]!.detail.source).toBe('add_agent_command');
    expect(Object.keys(events.rows[0]!.detail).sort()).toEqual(['source', 'warningId']);
  });

  it('updates existing free-agent instructions once while preserving their soul', async () => {
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,$3::jsonb)`, [AGENT, OWNER, JSON.stringify({ name: 'Fern', instructions: 'Original soul', avatarSeed: 'seed' })]);
    await db.query(`DELETE FROM workflow_backfills WHERE name='free-agent-connect-guide-v1'`);
    await migrateData(db);
    await migrateData(db);
    const soul = (await db.query<{ soul: { instructions: string; avatarSeed: string } }>(`SELECT soul FROM agents WHERE agent_id=$1`, [AGENT])).rows[0]!.soul;
    expect(soul.instructions).toBe(`Original soul\n\n${FREE_AGENT_CONNECT_GUIDE}`);
    expect(soul.avatarSeed).toBe('seed');
  });
});

it('pins trigger limits and the guide to the real Add agent command', async () => {
  // Compile the pure mobile helper without loading Expo's tsconfig in server-only CI.
  const source = readFileSync(new URL('../../mobile/sources/buzz/agent-pairing-command.ts', import.meta.url), 'utf8');
  const pairing = {} as { agentPairingCommand: (code: string) => string };
  runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
    { exports: pairing }, { timeout: 1000 });
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENTS: '1', BEELINE_FREE_AGENT_SEAL_KEY: 'seal', FLY_FREE_AGENT_IMAGE: 'image' })!;
  const instructions = freeAgentInstructions('Soul', 'Fern', config);
  expect(instructions).toContain(pairing.agentPairingCommand('<code>'));
  for (const text of ['Members -> Add agent', 'At most one unsolicited nudge per UTC day', 'When explicitly asked, help without this daily restriction', 'own files, apps, logins or local repository', 'job longer than your turn limit', 'Normal conversation is not a trigger', '80% warning counts', 'Claude Code, Codex or OpenCode', 'always-on machine', 'Never create, retrieve, request, repeat or post a pairing code', 'online without confirmation']) expect(instructions).toContain(text);
});
