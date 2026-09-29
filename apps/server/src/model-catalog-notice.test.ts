import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'b'.repeat(64);
const HUMAN = 'a'.repeat(64);

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Niglet','niglet')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'opus[1m]')`, [
    AGENT,
    HUMAN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT],
  );
  return database;
}

const MODEL_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'opus',
    options: [
      { id: 'sonnet', name: 'Sonnet 5.5' },
      { id: 'opus', name: 'Opus 5.5' },
    ],
  },
];

async function agentRow(database: PgliteDatabase) {
  return (
    await database.query<{ selected_model: string | null; model_unavailable: string | null }>(
      `SELECT selected_model,model_unavailable FROM agents WHERE agent_id=$1`,
      [AGENT],
    )
  ).rows[0];
}

async function ownerDmText(database: PgliteDatabase) {
  const rows = (
    await database.query<{ text: string }>(
      `SELECT m.text FROM messages m
       JOIN rooms r ON r.id=m.room_id
       JOIN memberships mem ON mem.room_id=r.id AND mem.identity_id=$1
       WHERE r.workspace_id=$2 ORDER BY m.created_at,m.id`,
      [HUMAN, WORKSPACE],
    )
  ).rows;
  return rows.map((row) => row.text);
}

describe('postAgentModelCatalog: automatic fallback notice', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await fixture();
  });
  afterEach(async () => {
    await database.close();
  });

  it('names the old and new model once when the daemon substitutes a same-family fallback', async () => {
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute(
      'postAgentModelCatalog',
      {
        agentId: AGENT,
        workspaceId: WORKSPACE,
        options: MODEL_OPTIONS,
        selection: { model: 'opus' },
      },
      AGENT,
    );
    expect(await agentRow(database)).toEqual({ selected_model: 'opus', model_unavailable: null });
    const texts = await ownerDmText(database);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toBe('@niglet switched models · opus[1m] is no longer offered; now using Opus 5.5.');
  });

  it('does not re-notify on the next routine catalog mirror once the correction has landed', async () => {
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute(
      'postAgentModelCatalog',
      { agentId: AGENT, workspaceId: WORKSPACE, options: MODEL_OPTIONS, selection: { model: 'opus' } },
      AGENT,
    );
    // The next activation's routine mirror posts the SAME (now-current)
    // selection back — this must not read as a second fallback.
    await daemon.execute(
      'postAgentModelCatalog',
      {
        agentId: AGENT,
        workspaceId: WORKSPACE,
        options: MODEL_OPTIONS,
        selection: { model: 'opus' },
        force: true,
      } as never,
      AGENT,
    );
    expect(await ownerDmText(database)).toHaveLength(1);
  });

  it('does not notify a going-unavailable post even if selection differs (that path owns its own notice)', async () => {
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute(
      'postAgentModelCatalog',
      {
        agentId: AGENT,
        workspaceId: WORKSPACE,
        options: MODEL_OPTIONS,
        selection: { model: 'opus' },
        unavailable: 'model',
      },
      AGENT,
    );
    const texts = await ownerDmText(database);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('needs a different model');
  });
});
