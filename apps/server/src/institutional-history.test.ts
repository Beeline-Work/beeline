import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import type { CommandRow } from './agent-command.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import {
  INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX,
  INSTITUTIONAL_HISTORY_MAX_AGE_DAYS,
  INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES,
} from '@beeline/api-contract/daemon';
import { searchInstitutionalHistory } from './institutional-history.js';
import { PgliteDatabase } from './test-support.js';
import type { QueryResult, SqlDatabase } from './database.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000101';
const OTHER_WORKSPACE = '10000000-0000-4000-8000-000000000102';
const OUTPUT = '20000000-0000-4000-8000-000000000101';
const SHARED = '20000000-0000-4000-8000-000000000102';
const PRIVATE = '20000000-0000-4000-8000-000000000103';
const OTHER = '20000000-0000-4000-8000-000000000104';
const CORNER = '20000000-0000-4000-8000-000000000105';
const REQUESTER = 'a'.repeat(64);
const OTHER_HUMAN = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const ROOT = 'root-message';

const command: CommandRow = {
  id: 'command-1',
  room_id: OUTPUT,
  agent_id: AGENT,
  source_message_id: ROOT,
  turn_request_id: 'request-1',
  action: 'input',
  reason: 'test',
  root_command_id: 'command-1',
  parent_command_id: null,
  root_source_message_id: ROOT,
  agent_depth: 0,
  state: 'claimed',
  generation_id: 'generation-1',
  lease_expires_at: new Date(Date.now() + 60_000),
  result_message_id: null,
  hiccup_attempts: 0,
  lifecycle_before: null,
  restart_confirmed_at: null,
};

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Requester'),($2,'human','Other human'),($3,'agent','Bee')`,
    [REQUESTER, OTHER_HUMAN, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'History'),($2,'Other')`, [
    WORKSPACE,
    OTHER_WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`,
    [WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name) VALUES
       ($1,$5,'Output'),($2,$5,'Shared source'),($3,$5,'Requester private'),
       ($4,$6,'Other workspace')`,
    [OUTPUT, SHARED, PRIVATE, OTHER, WORKSPACE, OTHER_WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Fix login')`,
    [CORNER, WORKSPACE, OUTPUT],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),
       ($1,$6,$2,'owner'),($1,$6,$3,'member'),($1,$6,$4,'member'),
       ($1,$7,$2,'owner'),($1,$7,$4,'member'),
       ($8,NULL,$2,'owner'),($8,$9,$2,'owner'),($8,$9,$4,'member')`,
    [WORKSPACE, REQUESTER, OTHER_HUMAN, AGENT, OUTPUT, SHARED, PRIVATE, OTHER_WORKSPACE, OTHER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'owner'),($1,$2,$4,'member')`,
    [WORKSPACE, CORNER, REQUESTER, AGENT],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
       ($1,$2,$3,'Please find our release notes.',now()-interval '4 minutes'),
       ('shared-result',$4,$3,'Release migration writes the schema marker last.',now()-interval '3 minutes'),
       ('private-result',$5,$3,'Private release marker instructions.',now()-interval '2 minutes'),
       ('deleted-result',$4,$3,'Deleted release marker text.',now()-interval '1 minute'),
       ('cross-workspace',$6,$3,'Other release marker text.',now())`,
    [ROOT, OUTPUT, REQUESTER, SHARED, PRIVATE, OTHER],
  );
  await database.query(`UPDATE messages SET deleted_at=now(),text='' WHERE id='deleted-result'`);
});

afterEach(async () => {
  await database.close();
});

describe('authorized institutional history search', () => {
  it('Reproduction RHS-1: finds the agreed workflow design with a natural-language query', async () => {
    await database.query(`UPDATE rooms SET name='Workflow Page Redesign' WHERE id=$1`, [SHARED]);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
       ('workflow-agreement',$1,$2,'The run page design shows each step and its receipt rail.',now()-interval '1 day'),
       ('workflow-weak',$1,$2,'A screen preview is ready.',now())`,
      [SHARED, REQUESTER],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, REQUESTER]);
    const active = await createAgentCommand(database, {
      roomId: OUTPUT,
      agentId: AGENT,
      sourceMessageId: ROOT,
      reason: 'human_tag',
      turnRequestId: 'rhs-1',
    });
    await claimAgentCommand(database, OUTPUT, AGENT, active!.id, 'rhs-generation');
    const daemon = new DaemonService(
      database,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { enabled: true, live: true },
    );
    const result = await daemon.execute(
      'searchInstitutionalHistory',
      {
        agentId: AGENT,
        roomId: OUTPUT,
        requestId: 'rhs-1',
        generationId: 'rhs-generation',
        query: 'workflow run screen UI design steps timeline',
        limit: 10,
      },
      AGENT,
    );
    console.log('Reproduction RHS-1:', JSON.stringify(result));
    expect(result.results[0]?.messageId).toBe('workflow-agreement');
    expect(result.results[0]?.roomName).toBe('Workflow Page Redesign');
  });

  it('intersects the source with the requester, agent, and complete output audience', async () => {
    const shared = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(shared.results.map((result) => result.messageId)).toEqual(['shared-result', ROOT]);
    expect(shared.results[0]).toMatchObject({
      roomId: SHARED,
      roomName: 'Shared source',
      authorId: REQUESTER,
    });
    expect(shared.results[0]?.snippet).toContain('Release migration');

    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [OUTPUT, OTHER_HUMAN],
    );
    const privateVisible = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(privateVisible.results.map((result) => result.messageId).sort()).toEqual(
      ['private-result', 'shared-result', ROOT].sort(),
    );
  });

  it('answers a corner turn whose durable request lives in the parent Room', async () => {
    const cornerCommand: CommandRow = { ...command, id: 'command-2', room_id: CORNER };
    const corner = await searchInstitutionalHistory(database, cornerCommand, {
      agentId: AGENT,
      roomId: CORNER,
      query: 'release marker',
      limit: 10,
    });
    // The corner's own human audience is the requester, so both readable
    // sources qualify; what the corner proves is that authority resolves at all.
    expect(corner.results.map((result) => result.messageId).sort()).toEqual(
      ['private-result', 'shared-result', ROOT].sort(),
    );
  });

  it('records the authorized Room count when the query matched nothing', async () => {
    const empty = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'nonexistentterm',
      limit: 10,
    });
    expect(empty).toMatchObject({ results: [], omitted: 0, capped: false });
    const telemetry = (
      await database.query<{ result_count: number; authorized_room_count: number }>(
        `SELECT result_count,authorized_room_count FROM institutional_history_searches`,
      )
    ).rows[0];
    expect(telemetry?.result_count).toBe(0);
    expect(telemetry?.authorized_room_count).toBeGreaterThanOrEqual(2);
  });

  it('pays the audience-authorization cost once per search', async () => {
    const statements: string[] = [];
    const recorded = (inner: SqlDatabase): SqlDatabase => ({
      query: <Row extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
        statements.push(sql);
        return inner.query(sql, values) as Promise<QueryResult<Row>>;
      },
      transaction: (work) => inner.transaction((db) => work(recorded(db))),
    });

    const searched = await searchInstitutionalHistory(recorded(database), command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(searched.results).not.toHaveLength(0);
    // The authorization CTE scans every Room with a correlated EXISTS per human
    // of the output Room, so its telemetry count must ride the ranking
    // statement rather than buying a second pass.
    expect(statements.filter((sql) => sql.includes('authorized_rooms AS'))).toHaveLength(1);
  });

  it('caps matching work and reports omitted against that bound', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT 'bulk-'||lpad(series::text,4,'0'),$1,$2,'Release marker bulk '||series,
              now()-interval '1 hour'+series*interval '1 second'
       FROM generate_series(1,$3::integer) series`,
      [SHARED, REQUESTER, INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX + 25],
    );
    const capped = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(capped.results).toHaveLength(10);
    expect(capped.capped).toBe(true);
    expect(capped.omitted).toBe(INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX - 10);

    // Equal word coverage keeps the newest matches; stronger coverage is tested below.
    const newestWindow = (
      await database.query<{ id: string }>(
        `SELECT id FROM messages
         WHERE deleted_at IS NULL AND presentation='message'
           AND search_document @@ websearch_to_tsquery('simple','release marker')
         ORDER BY created_at DESC,id DESC LIMIT $1`,
        [INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX],
      )
    ).rows.map((row) => row.id);
    expect(newestWindow).not.toContain('bulk-0001');
    for (const result of capped.results) expect(newestWindow).toContain(result.messageId);

    const repeated = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(repeated.results.map((result) => result.messageId)).toEqual(
      capped.results.map((result) => result.messageId),
    );
    expect(
      (
        await database.query<{ matches_capped: boolean; omitted_count: number }>(
          `SELECT matches_capped,omitted_count FROM institutional_history_searches`,
        )
      ).rows[0],
    ).toMatchObject({
      matches_capped: true,
      omitted_count: INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX - 10,
    });
  });

  it('matches English word forms and preserves exact tokens without double-counting them', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
       ('step-result',$1,$2,'Each step records a receipt.',now()-interval '1 hour'),
       ('repeated-result',$1,$2,'Step step step step.',now()),
       ('exact-result',$1,$2,'The zxq_42 identifier.',now())`,
      [SHARED, REQUESTER],
    );
    const result = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'steps receipts',
      limit: 10,
    });
    expect(result.results.map((row) => row.messageId)).toEqual(['step-result', 'repeated-result']);
    expect(result.results.map((row) => row.rank)).toEqual([2, 1]);
    const exact = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'zxq_42',
      limit: 10,
    });
    expect(exact.results.map((row) => row.messageId)).toEqual(['exact-result']);
  });

  it('searches current Room names without exposing unreadable Rooms', async () => {
    await database.query(`UPDATE rooms SET name='Workflow Page Redesign' WHERE id IN ($1,$2,$3)`, [
      SHARED,
      PRIVATE,
      OTHER,
    ]);
    const named = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: '"Workflow Page Redesign"',
      limit: 10,
    });
    expect(named.results.map((row) => row.messageId)).toEqual(['shared-result']);
    expect(named.results[0]?.rank).toBe(3);
    await database.query(`UPDATE rooms SET name='Receipt rails' WHERE id=$1`, [SHARED]);
    const renamed = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'receipt rail',
      limit: 10,
    });
    expect(renamed.results.map((row) => row.messageId)).toEqual(['shared-result']);
    const previous = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'Workflow Page Redesign',
      limit: 10,
    });
    expect(previous.results).toEqual([]);
  });

  it('keeps older strong matches ahead of more than 200 newer weak matches', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES
       ('strong-result',$1,$2,'Workflow run design step timeline.',now()-interval '30 days')`,
      [SHARED, REQUESTER],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT 'weak-'||series,$1,$2,'Workflow update.',now()-series*interval '1 second'
       FROM generate_series(1,$3::integer) series`,
      [SHARED, REQUESTER, INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX + 25],
    );
    const result = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'workflow run screen UI design steps timeline',
      limit: 1,
    });
    expect(result.results[0]).toMatchObject({ messageId: 'strong-result', rank: 5 });
    expect(result).toMatchObject({
      capped: true,
      omitted: INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX - 1,
    });
  });

  it('keeps maximum-coverage matches when Room names supply some terms', async () => {
    await database.query(`UPDATE rooms SET name='Workflow Page Redesign' WHERE id=$1`, [SHARED]);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT 'complete-'||lpad(series::text,4,'0'),$1,$2,'The run step.',
              now()-interval '1 day'+series*interval '1 second'
       FROM generate_series(1,$3::integer) series`,
      [SHARED, REQUESTER, INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX + 25],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('newer-partial',$1,$2,'The run.')`,
      [SHARED, REQUESTER],
    );
    const result = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'workflow run steps the',
      limit: 10,
    });
    expect(result.results[0]).toMatchObject({ messageId: 'complete-0225', rank: 4 });
    expect(result.results.every((row) => row.rank === 4)).toBe(true);
    expect(new Set(result.results.map((row) => row.messageId)).size).toBe(10);
    expect(result).toMatchObject({
      capped: true,
      omitted: INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX - 10,
    });
  });

  it('handles stopword-only and punctuation-only queries', async () => {
    const exact = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'the',
      limit: 10,
    });
    expect(exact.results.map((row) => row.messageId)).toEqual(['shared-result']);
    expect(exact.results[0]?.rank).toBe(1);
    const empty = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: '?!',
      limit: 10,
    });
    expect(empty.results).toEqual([]);
  });

  it('applies the same age and conversational-row bounds to Room-name matches', async () => {
    await database.query(`UPDATE rooms SET name='Workflow Page Redesign' WHERE id=$1`, [SHARED]);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at) VALUES
       ('old-named',$1,$2,'Agreed.','message',now()-interval '181 days'),
       ('empty-named',$1,$2,'','message',now()),
       ('system-named',$1,$2,'Agreed.','system',now()),
       ('card-named',$1,$2,'Agreed.','card',now())`,
      [SHARED, REQUESTER],
    );
    const result = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'Workflow Page Redesign',
      limit: 10,
    });
    expect(result.results.map((row) => row.messageId)).toEqual(['shared-result']);
    expect(result.windowDays).toBe(180);
  });

  it('keeps a clipped snippet inside the declared byte cap', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('long-result',$1,$2,'Release marker '||repeat('x ',600),now())`,
      [SHARED, REQUESTER],
    );
    const long = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    const snippet = long.results.find((result) => result.messageId === 'long-result')?.snippet;
    expect(snippet?.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(snippet ?? '', 'utf8')).toBeLessThanOrEqual(
      INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES,
    );
  });

  it('bounds matching to the reported recency window', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('ancient-result',$1,$2,'Release marker from the archives.',
              now()-($3::integer+1)*interval '1 day')`,
      [SHARED, REQUESTER, INSTITUTIONAL_HISTORY_MAX_AGE_DAYS],
    );
    const windowed = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(windowed.windowDays).toBe(INSTITUTIONAL_HISTORY_MAX_AGE_DAYS);
    expect(windowed.results.map((result) => result.messageId)).not.toContain('ancient-result');
    expect(windowed.results.map((result) => result.messageId)).toContain('shared-result');
  });

  it('bounds input and records content-free telemetry', async () => {
    await expect(
      searchInstitutionalHistory(database, command, {
        agentId: AGENT,
        roomId: OUTPUT,
        query: 'release',
        limit: 11,
      }),
    ).rejects.toThrow('limit is invalid');

    await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 1,
    });
    const telemetry = (
      await database.query<{
        query_hash: string;
        result_count: number;
        authorized_room_count: number;
      }>(
        `SELECT query_hash,result_count,authorized_room_count
         FROM institutional_history_searches`,
      )
    ).rows[0];
    expect(telemetry?.query_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(telemetry?.result_count).toBe(1);
    expect(telemetry?.authorized_room_count).toBeGreaterThanOrEqual(2);
  });

  it('serves a turn started by a schedule or event wake, whose root message is agent-authored', async () => {
    const scheduleRoot = 'schedule-wake-root';
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'daily triage sweep')`,
      [scheduleRoot, OUTPUT, AGENT],
    );
    const scheduleCommand: CommandRow = {
      ...command,
      id: 'schedule-root-command',
      source_message_id: scheduleRoot,
      root_source_message_id: scheduleRoot,
    };
    const result = await searchInstitutionalHistory(database, scheduleCommand, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(result.results.map((row) => row.messageId)).toContain('shared-result');
  });

  it('refuses when the root message\'s Room is in another Workspace than the calling Room', async () => {
    const crossWorkspaceCommand: CommandRow = {
      ...command,
      id: 'cross-workspace-command',
      source_message_id: 'cross-workspace',
      root_source_message_id: 'cross-workspace',
    };
    await expect(
      searchInstitutionalHistory(database, crossWorkspaceCommand, {
        agentId: AGENT,
        roomId: OUTPUT,
        query: 'release marker',
        limit: 10,
      }),
    ).rejects.toThrow(/requester authority is unavailable/);
  });
});
