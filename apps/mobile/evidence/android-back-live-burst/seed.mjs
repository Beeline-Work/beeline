import pg from 'pg';
import { createHash } from 'node:crypto';
const connectionString = process.env.LATENCY_RIG_DATABASE_URL;
if (!connectionString) throw new Error('LATENCY_RIG_DATABASE_URL is required');
const target = new URL(connectionString);
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
    !target.pathname.includes('latency_rig') ||
    (target.searchParams.has('host') && target.searchParams.get('host') !== '/var/run/postgresql'))
  throw new Error('Fixture writes require a loopback latency_rig database');
const db = new pg.Client({ connectionString });
const workspace = 'dc27ab0c-32d1-49ca-8361-e3ff4664bcd1';
const room = 'f13fbac4-e500-4f81-8c20-78bc02c3aac8';
const corner = 'a04a1c5f-e21b-4006-8eef-894e73c02b5b';
const dm = 'beebee00-0000-4000-8000-000000000025';
const human = createHash('sha256').update('beeline:play-review-identity').digest('hex');
const agent = createHash('sha256').update('beeline-latency-rig:agent').digest('hex');
await db.connect();
try {
  await db.query('BEGIN');
  const existing = await db.query('SELECT id FROM rooms WHERE id=$1 AND workspace_id=$2', [room, workspace]);
  if (!existing.rowCount) throw new Error('Run scripts/latency-rig/seed-local.mjs first');
  await db.query("DELETE FROM rooms WHERE workspace_id=$1 AND parent_id IS NULL AND left(name,12) > 'Rig room 025' AND direct_participants IS NULL", [workspace]);
  await db.query("UPDATE workspaces SET name='Latency Rig 25' WHERE id=$1", [workspace]);
  await db.query("UPDATE rooms SET name=name||' dddddddddddddddd' WHERE workspace_id=$1 AND parent_id IS NULL AND direct_participants IS NULL AND name<>'Rig room 001' AND name NOT LIKE '%dddddddddddddddd'", [workspace]);
  await db.query("UPDATE messages SET id=id||id WHERE room_id=$1 AND presentation='message' AND length(id)=32", [room]);
  for (const [id, destination, text] of [
    ['a'.repeat(64), room, 'Room ready aaaaaaaaaaaaaaaa'],
    ['b'.repeat(64), corner, 'Corner ready bbbbbbbbbbbbbbbb'],
  ]) await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,$4,now()+interval '1 day') ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at`,
  [id, destination, human, text]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
    VALUES($1,$2,$3,'Opened rig-corner-001','card','daemon-fact',$4,now()+interval '1 day')
    ON CONFLICT(id) DO UPDATE SET card=excluded.card,created_at=excluded.created_at`,
  ['c'.repeat(64), room, human, JSON.stringify({ type: 'corner-open', cornerId: corner,
    name: 'rig-corner-001', objective: 'Latency rig corner', sourceMessageId: 'a'.repeat(64) })]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,$2,$3,'member' WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,
  [workspace, corner, agent]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
    VALUES($1,$2,$3,'Direct message','invite-only',$4) ON CONFLICT(id) DO NOTHING`,
  [dm, workspace, human, JSON.stringify([human, agent].sort())]);
  for (const member of [human, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,$2,$3,'member' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`,
  [workspace, dm, member]);
  for (const [destination, prefix, text] of [
    [corner, 'back-corner-', 'Long transcript paragraph with **formatted text**. '.repeat(30)],
    [dm, 'back-dm-', 'DM history '],
  ]) await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    SELECT md5($3||n)||md5($3||n),$1,$2,$4||n,now()-interval '3 hours'+n*interval '1 second'
    FROM generate_series(1,1000) n ON CONFLICT(id) DO NOTHING`, [destination, human, prefix, text]);
  await db.query('COMMIT');
  console.log({ workspace, room, corner, dm });
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
