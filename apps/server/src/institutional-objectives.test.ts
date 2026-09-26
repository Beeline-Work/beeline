import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { institutionalObjectiveDashboard } from './institutional-curator.js';
import {
  recordInstitutionalCornerOutcome,
  recordInstitutionalMemoryTurnOutcome,
  recordInstitutionalServeUsage,
} from './institutional-memory-shadow.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000401';
const ROOM = '20000000-0000-4000-8000-000000000401';
const SERVICE_CORNER = '20000000-0000-4000-8000-000000000402';
const PLAIN_CORNER = '20000000-0000-4000-8000-000000000403';
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Requester'),($2,'agent','Worker')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Objectives')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [
    AGENT,
    HUMAN,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,created_at)
     VALUES($1,$2,'Objectives parent','Beeline-Work/beeline','repository',now()-interval '10 days')`,
    [ROOM, WORKSPACE],
  );
  // Both corners recur in the SAME repository; only one ever receives a serve,
  // which is exactly the eligible-versus-unserved comparison.
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,parent_id,created_at)
     VALUES($1,$2,'Served corner','Beeline-Work/beeline','repository',$3,now()-interval '5 days'),
           ($4,$2,'Plain corner','Beeline-Work/beeline','repository',$3,now()-interval '5 days')`,
    [SERVICE_CORNER, WORKSPACE, ROOM, PLAIN_CORNER],
  );
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`,
    [WORKSPACE],
  );
});

afterEach(async () => {
  await database.close();
});

async function seedServe(input: {
  roomId: string;
  requestId: string;
  served: boolean;
  totalBytes: number;
  estimatedTokens: number;
  actualInputTokens?: number;
  promptBytes?: number;
}): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO institutional_context_serves
     (id,workspace_id,room_id,request_id,requester_identity_id,mode,served,total_bytes,
      estimated_tokens,actual_input_tokens,prompt_bytes)
     VALUES($1,$2,$3,$4,$5,'live',$6,$7,$8,$9,$10)`,
    [
      id,
      WORKSPACE,
      input.roomId,
      input.requestId,
      HUMAN,
      input.served,
      input.totalBytes,
      input.estimatedTokens,
      input.actualInputTokens ?? null,
      input.promptBytes ?? null,
    ],
  );
  return id;
}

async function seedTurn(input: {
  roomId: string;
  requestId: string;
  status: 'complete' | 'failed';
  seconds: number;
  toolCalls?: number;
}): Promise<void> {
  await database.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at,created_at,tool_calls)
     VALUES($1,$2,$3,$4,now()-$5*interval '1 second',now(),$6)`,
    [input.roomId, input.requestId, AGENT, input.status, input.seconds, input.toolCalls ?? null],
  );
}

describe('institutional objective dashboard: real token budget and cohorts', () => {
  it('attributes the institutional block its real share of the harness token count', async () => {
    await seedServe({
      roomId: SERVICE_CORNER,
      requestId: 'served-turn-1',
      served: true,
      totalBytes: 4_000,
      estimatedTokens: 1_000,
      actualInputTokens: 40_000,
      promptBytes: 80_000,
    });
    // A serve the harness never reported on keeps the byte estimate, so the
    // sample does not silently shrink to only the measured turns.
    await seedServe({
      roomId: SERVICE_CORNER,
      requestId: 'served-turn-2',
      served: true,
      totalBytes: 800,
      estimatedTokens: 200,
    });
    const dashboard = await institutionalObjectiveDashboard(database, WORKSPACE);
    expect(dashboard.tokenSampledServes).toBe(1);
    expect(dashboard.p95TurnInputTokens).toBe(40_000);
    // 40,000 real prompt tokens × (4,000 / 80,000) institutional bytes = 2,000.
    expect(dashboard.p95ContextTokens).toBe(2_000);
    expect(dashboard.tokenShare).toBeCloseTo(2_000 / 40_000, 5);
  });

  it('records the turn’s real cost on the serve it answered, in its own transaction', async () => {
    const serveId = await seedServe({
      roomId: SERVICE_CORNER,
      requestId: 'usage-turn',
      served: true,
      totalBytes: 1_000,
      estimatedTokens: 250,
    });
    await seedTurn({
      roomId: SERVICE_CORNER,
      requestId: 'usage-turn',
      status: 'complete',
      seconds: 90,
    });
    await recordInstitutionalServeUsage(database, {
      roomId: SERVICE_CORNER,
      requestId: 'usage-turn',
      inputTokens: 12_000,
      promptBytes: 24_000,
    });
    const serve = (
      await database.query<{ actual_input_tokens: number; prompt_bytes: number }>(
        `SELECT actual_input_tokens,prompt_bytes FROM institutional_context_serves WHERE id=$1`,
        [serveId],
      )
    ).rows[0]!;
    expect(serve).toEqual({ actual_input_tokens: 12_000, prompt_bytes: 24_000 });

    await recordInstitutionalMemoryTurnOutcome(
      database,
      SERVICE_CORNER,
      'usage-turn',
      true,
      'complete',
    );
    const outcome = (
      await database.query<{ detail: { elapsedMs?: number; toolCalls?: number } }>(
        `SELECT detail FROM institutional_memory_outcomes
         WHERE room_id=$1 AND request_id=$2 AND kind='turn_completed'`,
        [SERVICE_CORNER, 'usage-turn'],
      )
    ).rows[0]!;
    expect(outcome.detail.elapsedMs).toBeGreaterThanOrEqual(89_000);
  });

  it('publishes cycle time and yield per cohort, and only compares clusters that have both', async () => {
    // The served corner received an eligible snapshot; the plain one never did.
    await seedServe({
      roomId: SERVICE_CORNER,
      requestId: 'served-yield',
      served: true,
      totalBytes: 2_000,
      estimatedTokens: 500,
    });
    await seedTurn({
      roomId: SERVICE_CORNER,
      requestId: 'served-yield',
      status: 'complete',
      seconds: 60,
      toolCalls: 4,
    });
    await seedTurn({
      roomId: PLAIN_CORNER,
      requestId: 'unserved-yield',
      status: 'failed',
      seconds: 300,
    });
    await recordInstitutionalCornerOutcome(database, {
      cornerId: SERVICE_CORNER,
      kind: 'merged',
    });
    await recordInstitutionalCornerOutcome(database, { cornerId: PLAIN_CORNER, kind: 'merged' });

    const dashboard = await institutionalObjectiveDashboard(database, WORKSPACE);
    expect(dashboard.cornerCycleTime.map((entry) => entry.cohort).sort()).toEqual([
      'served',
      'unserved',
    ]);
    for (const entry of dashboard.cornerCycleTime) {
      // Both corners were created five days ago and merged now.
      expect(entry.mergedCorners).toBe(1);
      expect(entry.p50Minutes).toBeGreaterThan(7_000);
    }
    expect(dashboard.comparableClusters).toHaveLength(1);
    expect(dashboard.comparableClusters[0]!.repository).toBe('Beeline-Work/beeline');

    const served = dashboard.yieldByCohort.find((entry) => entry.cohort === 'served')!;
    const unserved = dashboard.yieldByCohort.find((entry) => entry.cohort === 'unserved')!;
    expect(served).toMatchObject({
      corners: 1,
      completedTurns: 1,
      successfulTurns: 1,
      measuredTurns: 1,
      successRate: 1,
    });
    expect(served.toolCallsPerSuccessfulTurn).toBe(4);
    expect(served.turnMinutesP50).toBeCloseTo(1, 3);
    expect(unserved).toMatchObject({
      corners: 1,
      completedTurns: 1,
      successfulTurns: 0,
      measuredTurns: 0,
      successRate: 0,
    });
    // No turn in the unserved cohort reported a tool count, so its average is
    // zero WITH a zero sample rather than a claim about behaviour.
    expect(unserved.toolCallsPerSuccessfulTurn).toBe(0);
    expect(unserved.turnMinutesP50).toBeCloseTo(5, 3);
  });
});
