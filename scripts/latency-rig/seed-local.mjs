#!/usr/bin/env node
/** Deterministic, disposable fixture for the local monolith only. */
import { createHash } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.LATENCY_RIG_DATABASE_URL;
if (!connectionString) throw new Error('LATENCY_RIG_DATABASE_URL is required');
const target = new URL(connectionString);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
    (target.searchParams.has('host') &&
      target.searchParams.get('host') !== '/var/run/postgresql') ||
    !/latency_rig/.test(target.pathname)) {
  throw new Error('Fixture writes require a loopback PostgreSQL host and a latency_rig database');
}

const id = (name) => {
  const hex = createHash('sha256').update(`beeline-latency-rig:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const messageId = (name) => createHash('sha256').update(`beeline-latency-rig:message:${name}`).digest('hex');
const reviewId = createHash('sha256').update('beeline:play-review-identity').digest('hex');
const agentId = createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
const database = new pg.Client({ connectionString, application_name: 'beeline_latency_rig_seed' });

await database.connect();
try {
  await database.query('BEGIN');
  await database.query(`INSERT INTO identities(id,kind,name,handle,welcome_cards_due)
    VALUES($1,'human','Latency Rig','latency-rig',false)
    ON CONFLICT(id) DO UPDATE SET welcome_cards_due=false`, [reviewId]);
  await database.query(`INSERT INTO identities(id,kind,name,handle)
    VALUES($1,'agent','Rig Agent','rig-agent') ON CONFLICT(id) DO NOTHING`, [agentId]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)
    ON CONFLICT(agent_id) DO NOTHING`, [agentId, reviewId]);
  const fixtures = [];
  for (const roomCount of [1, 10, 200]) {
    const workspaceId = id(`workspace-${roomCount}`);
    const roomId = id(`room-${roomCount}-0`);
    await database.query(`INSERT INTO workspaces(id,name,visibility) VALUES($1,$2,'invite-only')
      ON CONFLICT(id) DO NOTHING`, [workspaceId, `Latency Rig ${roomCount}`]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role)
      SELECT $1,$2,'owner' WHERE NOT EXISTS (
        SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
          AND identity_id=$2 AND removed_at IS NULL)`, [workspaceId, reviewId]);
    const roomIds = Array.from({ length: roomCount }, (_, index) => id(`room-${roomCount}-${index}`));
    const names = roomIds.map((_, index) => `Rig room ${String(index + 1).padStart(3, '0')}`);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name)
      SELECT room_id::uuid,$1,$2,name FROM unnest($3::text[],$4::text[]) AS r(room_id,name)
      ON CONFLICT(id) DO NOTHING`, [workspaceId, reviewId, roomIds, names]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT $1,room_id::uuid,$2,'owner' FROM unnest($3::text[]) AS r(room_id)
      WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.room_id=r.room_id::uuid
        AND m.identity_id=$2 AND m.removed_at IS NULL)`, [workspaceId, reviewId, roomIds]);
    fixtures.push({ roomCount, workspaceId, roomId });
  }
  const busy = fixtures.at(-1);
  await database.query(`INSERT INTO memberships(workspace_id,identity_id,role)
    SELECT $1,$2,'member' WHERE NOT EXISTS (
      SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL
        AND identity_id=$2 AND removed_at IS NULL)`, [busy.workspaceId, agentId]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,$2,$3,'member' WHERE NOT EXISTS (
      SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,
  [busy.workspaceId, busy.roomId, agentId]);
  const cornerIds = Array.from({ length: 300 }, (_, index) => id(`corner-${index}`));
  const cornerNames = cornerIds.map((_, index) => `rig-corner-${String(index + 1).padStart(3, '0')}`);
  await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
    SELECT corner_id::uuid,$1,$2,$3,name FROM unnest($4::text[],$5::text[]) AS c(corner_id,name)
    ON CONFLICT(id) DO NOTHING`, [busy.workspaceId, busy.roomId, reviewId, cornerIds, cornerNames]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,corner_id::uuid,$2,'owner' FROM unnest($3::text[]) AS c(corner_id)
    WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.room_id=c.corner_id::uuid
      AND m.identity_id=$2 AND m.removed_at IS NULL)`, [busy.workspaceId, reviewId, cornerIds]);
  await database.query(`INSERT INTO corner_facts(corner_id,commissioned_by,objective,kind)
    SELECT corner_id::uuid,$1,'Latency rig corner','human'
    FROM unnest($2::text[]) AS c(corner_id) ON CONFLICT(corner_id) DO NOTHING`, [reviewId, cornerIds]);
  await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at,created_at)
    VALUES($1,$2,$3,'working',now()-interval '90 days',now()-interval '90 days')
    ON CONFLICT(room_id,request_id,agent_id) DO NOTHING`,
  [busy.roomId, messageId('old-activity-turn'), agentId]);
  // Generate 10k activity rows and the first visible message window in one
  // indexed insert each. The old rows exercise the activity_rows projection.
  // The stable IDs make re-seeding idempotent; timestamps keep the visible page
  // above the 10k history rows without touching production data.
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
    SELECT md5('beeline-latency-rig-old-' || n),$1,$2,'Activity ' || n,
      'activity','[]'::jsonb,
      now() - interval '90 days' + n * interval '1 second'
    FROM generate_series(1,10000) AS n
    ON CONFLICT(id) DO UPDATE SET author_id=EXCLUDED.author_id,
      presentation='activity',activity='[]'::jsonb`, [busy.roomId, agentId]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    SELECT md5('beeline-latency-rig-window-' || n),$1,$2,'Window message ' || n,
      now() - interval '1 hour' + n * interval '1 second'
    FROM generate_series(1,30) AS n ON CONFLICT(id) DO NOTHING`, [busy.roomId, reviewId]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,repeat('streamed answer ',640),now()) ON CONFLICT(id) DO NOTHING`,
    [messageId('10kb-answer'), busy.roomId, reviewId]);
  await database.query('COMMIT');
  console.log(JSON.stringify({ fixtures, busyCornerId: cornerIds[0],
    cornerCount: cornerIds.length, oldActivityRows: 10000, windowRows: 30,
    largeAnswerBytes: Buffer.byteLength('streamed answer '.repeat(640)) }));
} catch (error) {
  await database.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await database.end();
}
