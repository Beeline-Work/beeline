import process from 'node:process';
import { Pool, type PoolClient } from 'pg';

const PREFIXES = [
  'Beeline bundle',
  'Agent unavailable: I could not access this Room',
  'Agent available again: repository access recovered',
  'Agent is thinking…',
  'Agent reply complete.',
  'Corner session live.',
] as const;

const mode = process.argv.includes('--execute')
  ? 'execute'
  : process.argv.includes('--dry-run')
    ? 'dry-run'
    : undefined;

async function main(): Promise<void> {
  if (!mode || (process.argv.includes('--execute') && process.argv.includes('--dry-run'))) {
    throw new Error(
      'usage: node --import tsx scripts/cleanup-legacy-daemon-chat.ts --dry-run|--execute',
    );
  }
  const databaseUrl = process.env.BUZZY_PUSH_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('set BUZZY_PUSH_DATABASE_URL or DATABASE_URL');

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = await legacyDaemonRows(client);
    console.log(JSON.stringify({ mode, count: report.count, sample: report.sample }, null, 2));

    if (mode === 'execute' && report.count > 0) {
      const deleted = await client.query<{ id: Buffer }>(
        `${candidateSql()}
         UPDATE events e
         SET deleted_at = now()
         FROM candidates c
         WHERE e.id = c.id
         RETURNING e.id`,
        [PREFIXES.map((prefix) => `${prefix}%`)],
      );
      console.log(`soft-deleted ${deleted.rowCount ?? 0} legacy daemon chat rows`);
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

function candidateSql(): string {
  return `WITH candidates AS (
    SELECT e.id
    FROM events e
    WHERE e.deleted_at IS NULL
      AND e.kind = 9
      AND e.content LIKE ANY($1::text[])
      AND EXISTS (
        SELECT 1
        FROM events author_agent
        WHERE author_agent.deleted_at IS NULL
          AND author_agent.community_id = e.community_id
          AND author_agent.pubkey = e.pubkey
          AND author_agent.kind = 9
          AND author_agent.tags @> '[["t", "buzz-agent"]]'::jsonb
      )
  )`;
}

async function legacyDaemonRows(database: PoolClient): Promise<{
  count: number;
  sample: Array<{ id: string; author: string; createdAt: string; content: string }>;
}> {
  const values = [PREFIXES.map((prefix) => `${prefix}%`)];
  const count = await database.query<{ count: string }>(
    `${candidateSql()} SELECT count(*)::text AS count FROM candidates`,
    values,
  );
  const sample = await database.query<{
    id: string;
    author: string;
    createdAt: string;
    content: string;
  }>(
    `${candidateSql()}
     SELECT encode(e.id, 'hex') AS id,
       encode(e.pubkey, 'hex') AS author,
       e.created_at::text AS "createdAt",
       left(e.content, 240) AS content
     FROM events e
     JOIN candidates c ON c.id = e.id
     ORDER BY e.created_at DESC, e.id
     LIMIT 20`,
    values,
  );
  return { count: Number(count.rows[0]?.count ?? 0), sample: sample.rows };
}
