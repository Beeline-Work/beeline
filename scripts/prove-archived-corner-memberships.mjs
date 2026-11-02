// Synthetic owner-shaped fixture, isolated PostgreSQL engine and loopback HTTP only.
// Build first: npm run build -w @beeline/server
// Baseline: --source-root=.beeline-proof/archived-corner-memberships/baseline/apps/server/src
import assert from 'node:assert/strict';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';

const source = process.argv
  .find((arg) => arg.startsWith('--source-root='))
  ?.slice('--source-root='.length);
const root = resolve(source ?? 'apps/server/dist');
assert(
  !relative(process.cwd(), root).startsWith('..'),
  'proof modules must be inside this worktree',
);
const mod = (name) => import(pathToFileURL(`${root}/${name}.${source ? 'ts' : 'js'}`).href);
const { migrate } = await mod('database');
const { PhoneService } = await mod('phone-service');
const { DaemonService } = await mod('daemon-service');
const { LiveHub } = await mod('live');
const { TokenAuth, tokenHash } = await mod('auth');
const { createBeelineServer } = await mod('server');
const db = new PgliteDatabase();
const owner = 'a'.repeat(64),
  workspace = '11111111-1111-4111-8111-111111111111';
const fixtureTime = '2026-09-02T12:00:00Z';
const token = 'bat_archived_corner_fixture';
let server;
let socket;
try {
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Fixture Owner','fixture-owner')`,
    [owner],
  );
  await db.query(`INSERT INTO identities(id,kind,name,handle)
    SELECT repeat(md5('fixture-agent-'||n),2),'agent','Agent '||n,'fixture-agent-'||n FROM generate_series(1,36) n`);
  await db.query(
    `INSERT INTO agents(agent_id,owner_id) SELECT id,$1 FROM identities WHERE kind='agent' AND handle LIKE 'fixture-agent-%'`,
    [owner],
  );
  await db.query(
    `INSERT INTO workspaces(id,name,created_at,updated_at) VALUES($1,'Fixture Workspace',$2,$2)`,
    [workspace, fixtureTime],
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_at,updated_at)
    SELECT md5('fixture-room-'||n)::uuid,$1,'Room '||n,$2,$2 FROM generate_series(1,43) n`,
    [workspace, fixtureTime],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,surface,identity.id,'owner' FROM (
      SELECT NULL::uuid surface UNION ALL SELECT id FROM rooms WHERE workspace_id=$1
    ) places CROSS JOIN identities identity WHERE (identity.id=$2 OR identity.handle LIKE 'fixture-agent-%')
      AND (surface IS NULL OR identity.id=$2 OR surface=md5('fixture-room-1')::uuid)`,
    [workspace, owner],
  );
  // Seed the physical roster an old image left on already archived corners.
  await db.query(`DROP TRIGGER IF EXISTS guard_corner_membership ON memberships`);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by,archived_at,created_at,updated_at)
    SELECT md5('fixture-corner-'||n)::uuid,$1,md5('fixture-room-'||(1+(n-1)%43))::uuid,
      CASE WHEN n<=11 THEN 'Active ' ELSE 'Archived ' END||n,$2,
      CASE WHEN n>11 THEN $3::timestamptz END,$3,$3 FROM generate_series(1,1157) n`,
    [workspace, owner, fixtureTime],
  );
  await db.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by)
    SELECT id,repeat(md5('fixture-agent-1'),2),$2 FROM rooms WHERE workspace_id=$1 AND parent_id IS NOT NULL`,
    [workspace, owner],
  );
  const activeCorner = (await db.query(`SELECT id FROM rooms WHERE name='Active 1'`)).rows[0].id;
  await db.query(
    `UPDATE corner_facts SET worker_agent_id=repeat(md5('fixture-agent-1'),2),
    reviewer_agent_id=repeat(md5('fixture-agent-2'),2) WHERE corner_id=$1`,
    [activeCorner],
  );
  const assignments = (
    await db.query(
      `SELECT owner_agent_id,worker_agent_id,reviewer_agent_id
    FROM corner_facts WHERE corner_id=$1`,
      [activeCorner],
    )
  ).rows[0];
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    SELECT $1,corner.id,parent.identity_id,'member' FROM rooms corner
    JOIN memberships parent ON parent.room_id=corner.parent_id AND parent.removed_at IS NULL
    WHERE corner.workspace_id=$1 AND corner.parent_id IS NOT NULL`,
    [workspace],
  );
  await db.query(`ALTER TABLE messages DISABLE TRIGGER USER`);
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
    SELECT 'fixture-message-'||id,id,$2,'Synthetic history for '||name,$3 FROM rooms WHERE workspace_id=$1`,
    [workspace, owner, fixtureTime],
  );
  await db.query(`ALTER TABLE messages ENABLE TRIGGER USER`);
  const before = (
    await db.query(
      `SELECT count(*)::int count FROM memberships
    WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL`,
      [owner],
    )
  ).rows[0].count;
  assert.equal(before, 1200);
  // Exercise the normal release data sequence, including the archived-membership backfill.
  console.error('fixture seeded; running release data migration');
  await migrate(db);
  console.error('release data migration completed');
  const stored = (
    await db.query(
      `SELECT count(*)::int count FROM memberships
    WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL`,
      [owner],
    )
  ).rows[0].count;
  const expanded = await db.query(
    `SELECT room_id FROM ${source ? 'effective_memberships' : 'room_access'} WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL`,
    [owner],
  );
  assert.equal(stored, source ? 1200 : 43);
  assert.equal(expanded.rowCount, source ? 1200 : 54);
  assert.deepEqual(
    (
      await db.query(
        `SELECT owner_agent_id,worker_agent_id,reviewer_agent_id
    FROM corner_facts WHERE corner_id=$1`,
        [activeCorner],
      )
    ).rows[0],
    assignments,
  );
  await db.query(
    `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
    VALUES($1,$2,$3,now()+interval '1 hour')`,
    [tokenHash(token), owner, workspace],
  );
  const live = new LiveHub();
  const daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  server = createBeelineServer({
    database: db,
    daemon,
    live,
    auth: new TokenAuth(db, async () => {
      throw Error('unused fixture authentication');
    }),
    phone: new PhoneService(db, 'http://fixture.test'),
    mediaMaximumBytes: 1,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const started = performance.now();
    const response = await fetch(`${origin}/v1/phone${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return {
      ms: performance.now() - started,
      bytes: Buffer.byteLength(text),
      body: JSON.parse(text),
    };
  };
  console.error('measuring loopback phone startup');
  const workspaces = await get('/workspaces');
  const workspaceRead = await get(`/workspaces/${workspace}`);
  const chatsPath = `/workspaces/${workspace}/chats`;
  const cold = await get(chatsPath);
  assert.equal(cold.body.chats.length, 43);
  assert.equal(cold.body.chats.flatMap((chat) => chat.openCorners ?? []).length, 11);
  assert.equal(cold.body.watchFilters.flatMap((filter) => filter['#h'] ?? []).length, 43);
  const archivedIds = (
    await db.query(`SELECT id FROM rooms WHERE workspace_id=$1 AND archived_at IS NOT NULL`, [
      workspace,
    ])
  ).rows.map((row) => row.id);
  for (const read of [workspaces, workspaceRead, cold])
    for (const id of archivedIds)
      assert(!JSON.stringify(read.body).includes(id), 'archived corner leaked into startup');
  const warm = [];
  for (let n = 0; n < 7; n++) warm.push((await get(chatsPath)).ms);
  warm.sort((a, b) => a - b);
  const history = await get(`/rooms/${archivedIds[0]}`);
  assert(history.body.messages.some((message) => message.text.startsWith('Synthetic history')));
  if (!source) assert.deepEqual(history.body.watchFilters, []);
  const frames = [];
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token}`]);
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(JSON.stringify(frames)));
      }, 5_000);
      const poll = setInterval(() => {
        if (predicate()) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
  socket.send(JSON.stringify({ type: 'subscribe', roomId: activeCorner }));
  await wait(() =>
    frames.some((frame) => frame.type === 'subscribed' && frame.roomId === activeCorner),
  );
  const response = await fetch(`${origin}/v1/phone/operations/sendRoomMessage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId: activeCorner,
      messageId: 'e'.repeat(64),
      text: 'Active corner still works',
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert(
    (await get(`/rooms/${activeCorner}`)).body.messages.some(
      (message) => message.text === 'Active corner still works',
    ),
  );
  const mark = frames.length;
  live.publish({ type: 'invalidate', roomId: activeCorner, reason: 'parent-access-proof' });
  await wait(() =>
    frames
      .slice(mark)
      .some((frame) => frame.type === 'invalidate' && frame.roomId === activeCorner),
  );
  console.log(
    JSON.stringify({
      proof: 'ARCHIVED-MEMBERSHIPS-1',
      mode: source ? 'before' : 'after',
      fixture: { rooms: 43, activeCorners: 11, archivedCorners: 1146, agents: 36 },
      ownerStoredMemberships: stored,
      inheritedSurfaceAccessCount: expanded.rowCount,
      membershipProjectionBytes: Buffer.byteLength(
        JSON.stringify(
          (
            await db.query(
              `SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL`,
              [owner],
            )
          ).rows,
        ),
      ),
      startupPayloadBytes: workspaces.bytes + workspaceRead.bytes + cold.bytes,
      roomListPayloadBytes: cold.bytes,
      roomListColdMs: +cold.ms.toFixed(2),
      roomListWarmMedianMs: +warm[3].toFixed(2),
      samples: 7,
      archivedCornersInStartup: 0,
      archivedHistoryReadable: true,
      activeCornerPost: true,
      activeCornerLiveUpdates: true,
      agentAssignmentsPreserved: true,
    }),
  );
} finally {
  socket?.terminate();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
}
