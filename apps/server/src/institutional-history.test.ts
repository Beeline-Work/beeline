import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import type { CommandRow } from './agent-command.js';
import { INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX } from '@beeline/api-contract/daemon';
import { searchInstitutionalHistory } from './institutional-history.js';
import { PgliteDatabase } from './test-support.js';

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
  it('intersects the source with the requester, agent, and complete output audience', async () => {
    const shared = await searchInstitutionalHistory(database, command, {
      agentId: AGENT,
      roomId: OUTPUT,
      query: 'release marker',
      limit: 10,
    });
    expect(shared.results.map((result) => result.messageId)).toEqual(['shared-result']);
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
      ['private-result', 'shared-result'].sort(),
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
      ['private-result', 'shared-result'].sort(),
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

    // The bound keeps the NEWEST matches, so the oldest 25 can never be ranked.
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
});
