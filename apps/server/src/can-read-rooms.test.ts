import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000301';
const ALLOWED_A = '20000000-0000-4000-8000-000000000301';
const ALLOWED_B = '20000000-0000-4000-8000-000000000302';
const DENIED = '20000000-0000-4000-8000-000000000303';
const VIEWER = 'e'.repeat(64);
const OUTSIDER = 'f'.repeat(64);

describe('PhoneService.canReadRooms batch authorization', () => {
  let phone: PhoneService;

  beforeAll(async () => {
    const database = new PgliteDatabase(new PGlite());
    await migrate(database);
    phone = new PhoneService(database, 'http://local.test');
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Batch Viewer','batch'),($2,'human','Outsider','out')`,
      [VIEWER, OUTSIDER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Batch auth')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [WORKSPACE, VIEWER, OUTSIDER],
    );
    for (const [roomId, name] of [
      [ALLOWED_A, 'Allowed A'],
      [ALLOWED_B, 'Allowed B'],
      [DENIED, 'Denied'],
    ] as const) {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
         VALUES($1,$2,NULL,$3,$4)`,
        [roomId, WORKSPACE, VIEWER, name],
      );
    }
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$4,$3,'owner')`,
      [WORKSPACE, ALLOWED_A, VIEWER, ALLOWED_B],
    );
  }, 60_000);

  it('returns only currently membered Rooms from one batch query', async () => {
    const readable = await phone.canReadRooms([ALLOWED_A, DENIED, ALLOWED_B, DENIED], VIEWER);
    expect([...readable].sort()).toEqual([ALLOWED_A, ALLOWED_B].sort());
    expect(readable.has(DENIED)).toBe(false);

    const outsider = await phone.canReadRooms([ALLOWED_A, ALLOWED_B, DENIED], OUTSIDER);
    expect(outsider.size).toBe(0);
  });
});
