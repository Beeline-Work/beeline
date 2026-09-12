import { mkdir, writeFile } from 'node:fs/promises';
import { migrate } from '../../../apps/server/src/database.js';
import { PgliteDatabase } from '../../../apps/server/src/test-support.js';
import { PhoneService } from '../../../apps/server/src/phone-service.js';
import { DaemonService } from '../../../apps/server/src/daemon-service.js';
import { LiveHub } from '../../../apps/server/src/live.js';

const human = 'a'.repeat(64),
  sol = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
await mkdir('.scratch/relay-proof', { recursive: true });
const db = new PgliteDatabase();
await migrate(db);
await db.query(
  `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Captain','captain'),($2,'agent','Sol','sol')`,
  [human, sol],
);
await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [sol, human]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [workspace]);
await db.query(
  `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'beeline'),($2,$3,'Endpoint work')`,
  [room, corner, workspace],
);
await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [room, corner]);
await db.query(
  `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle) VALUES($1,$2,'Update the endpoint and verify the phone flow','{}')`,
  [corner, sol],
);
for (const person of [human, sol])
  for (const scope of [null, room, corner])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [workspace, scope, person],
    );
const card = {
  type: 'corner-open',
  cornerId: corner,
  name: 'Endpoint work',
  objective: 'Update the endpoint and verify the phone flow',
};
await db.query(
  `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Endpoint work','card','daemon-fact',$4::jsonb)`,
  ['c'.repeat(64), room, sol, JSON.stringify(card)],
);
const phone = new PhoneService(db, 'http://127.0.0.1');
const daemon = new DaemonService(db, new LiveHub());
async function start(scope: string, text: string) {
  await phone.execute('sendRoomMessage', { roomId: scope, text }, human);
  const command = (await daemon.execute('getAgentCommands', { roomId: scope }, sol)).commands[0]!;
  await daemon.execute(
    'claimAgentCommand',
    { roomId: scope, commandId: command.id, generationId: 'proof' },
    sol,
  );
  return command;
}
const cornerTurn = await start(corner, '@sol update the endpoint and check the phone flow.');
const roomTurn = await start(
  room,
  '@sol the endpoint changed. Pass the details to the work already under way.',
);
const down = await daemon.execute(
  'postRoomMessage',
  {
    roomId: room,
    requestId: roomTurn.turnRequestId,
    generationId: 'proof',
    text: 'The endpoint is now /v2/rooms. Keep the existing response shape so the phone can ship independently. Please check both a fresh sign-in and an already-open Room, then report any compatibility blocker here before changing the client.',
    relay: { fromRoomId: room, toRoomId: corner, direction: 'down' },
  },
  sol,
);
const queued = (await daemon.execute('getAgentCommands', { roomId: corner }, sol)).commands;
if (queued[0]?.sourceMessageId !== down.id || queued[0]?.reason !== 'relay_steer')
  throw new Error('steer was not queued');
await daemon.execute(
  'postRoomMessage',
  {
    roomId: corner,
    requestId: cornerTurn.turnRequestId,
    generationId: 'proof',
    text: 'The endpoint change is ready. Fresh sign-in and an already-open Room both pass. No client update is required.',
    relay: { fromRoomId: corner, toRoomId: room, direction: 'up' },
  },
  sol,
);
await writeFile(
  '.scratch/relay-proof/data.json',
  JSON.stringify(
    {
      room: await phone.readRoom(room, human),
      corner: await phone.readRoom(corner, human),
      queued,
    },
    null,
    2,
  ),
);
await writeFile(
  'docs/evidence/room-corner-relays/queued-steer.json',
  JSON.stringify(queued, null, 2),
);
await db.close();
