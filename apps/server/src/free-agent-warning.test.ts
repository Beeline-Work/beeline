import { agentPairingCommand } from '../../mobile/sources/buzz/agent-pairing-command.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { freeAgentConfigFromEnv, freeAgentInstructions } from './free-agents.js';
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
  const usage = async (day: string, tokens: number) => db.query(
    `INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,$2,$3) ON CONFLICT(owner_id,day) DO UPDATE SET tokens=$3`, [OWNER, day, tokens]);
  const warn = (day = DAY) => warnFreeAgentOwner(db, AGENT, OWNER, day, 1000);

  it('delivers once per UTC day at 80%, privately, through the owner Room read', async () => {
    await usage(DAY, 799);
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
});

it('pins trigger limits and the guide to the real Add agent command', async () => {
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENTS: '1', BEELINE_FREE_AGENT_SEAL_KEY: 'seal', FLY_FREE_AGENT_IMAGE: 'image' })!;
  const instructions = freeAgentInstructions('Soul', 'Fern', config);
  expect(instructions).toContain(agentPairingCommand('<code>'));
  for (const text of ['Members -> Add agent', 'At most one unsolicited nudge per UTC day', 'Normal conversation is not a trigger', '80% warning counts', 'Claude Code, Codex or OpenCode', 'always-on machine', 'Never create, retrieve, request, repeat or post a pairing code', 'online without confirmation']) expect(instructions).toContain(text);
});
