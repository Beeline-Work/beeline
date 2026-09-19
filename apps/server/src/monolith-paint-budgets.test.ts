import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000201';
const ROOM = '20000000-0000-4000-8000-000000000201';
const VIEWER = 'd'.repeat(64);

/** Product page-load target used by the fanout audit (not a named in-tree constant). */
const PAGE_LOAD_TARGET_MS = 450;

/**
 * Monolith cold/warm Room-deck and transcript paint path proof.
 * Exercises PhoneService.readChats / readRoom — the same authority the phone
 * paints — and prints observable timings against the 450 ms page target.
 */
describe('monolith paint budgets (deck + transcript)', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;

  beforeAll(async () => {
    database = new PgliteDatabase(new PGlite());
    await migrate(database);
    phone = new PhoneService(database, 'http://local.test');
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Paint Viewer','paint')`,
      [VIEWER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Paint corpus')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
       VALUES($1,$2,NULL,$3,'Paint Room')`,
      [ROOM, WORKSPACE, VIEWER],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [WORKSPACE, VIEWER, ROOM],
    );
    for (let i = 0; i < 40; i += 1) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,$4,now()-($5::integer * interval '1 second'))`,
        [`paint-msg-${String(i).padStart(3, '0')}`, ROOM, VIEWER, `line ${i}`, i],
      );
    }
  }, 60_000);

  it('cold and warm deck/transcript reads stay under the 450 ms page target', async () => {
    const measure = async (label: string, work: () => Promise<unknown>) => {
      const started = performance.now();
      await work();
      const elapsedMs = performance.now() - started;
      console.log(JSON.stringify({ path: label, elapsedMs: Math.round(elapsedMs * 100) / 100 }));
      return elapsedMs;
    };

    const coldDeck = await measure('monolith-deck-cold', () => phone.readChats(WORKSPACE, VIEWER));
    const warmDeck = await measure('monolith-deck-warm', () => phone.readChats(WORKSPACE, VIEWER));
    const coldRoom = await measure('monolith-transcript-cold', () => phone.readRoom(ROOM, VIEWER));
    const warmRoom = await measure('monolith-transcript-warm', () => phone.readRoom(ROOM, VIEWER));

    for (const [label, elapsedMs] of [
      ['cold deck', coldDeck],
      ['warm deck', warmDeck],
      ['cold transcript', coldRoom],
      ['warm transcript', warmRoom],
    ] as const) {
      expect(elapsedMs, `${label} exceeded ${PAGE_LOAD_TARGET_MS} ms`).toBeLessThanOrEqual(
        PAGE_LOAD_TARGET_MS,
      );
    }
  });
});
