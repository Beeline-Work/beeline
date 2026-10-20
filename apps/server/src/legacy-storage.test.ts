import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';

describe('historical storage compatibility', () => {
  it('creates historical tables on an empty database and preserves rows on a second migration', async () => {
    const database = new PgliteDatabase();
    try {
      await migrate(database);
      const names = [
        'beeline_materializer_reservations',
        'beeline_room_read_marks',
        'beeline_agent_pairing_claims',
        'beeline_agent_pairing_claim_memberships',
        'beeline_agent_connect_grants',
      ];
      for (const name of names) {
        const result = await database.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename=$1",
          [name],
        );
        expect(result.rows).toEqual([{ name }]);
      }
      await database.query(`INSERT INTO beeline_materializer_reservations(consumer,state)
        VALUES ('compatibility-proof','{"cursor":1}')`);
      await migrate(database);
      const result = await database.query<{ state: unknown }>(
        `SELECT state FROM beeline_materializer_reservations WHERE consumer='compatibility-proof'`,
      );
      expect(result.rows).toEqual([{ state: { cursor: 1 } }]);
    } finally {
      await database.close();
    }
  });
});
