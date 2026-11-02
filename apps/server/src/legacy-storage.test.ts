import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { migratedDatabase } from './test-support.js';

describe('historical storage compatibility', () => {
  it('keeps the connect-grant table and its rows, and drops the retired empty tables', async () => {
    const database = await migratedDatabase();
    try {
      await database.query(`INSERT INTO beeline_agent_connect_grants
        (token_hash,community_id,workspace_id,minter_pubkey,agent_pubkey,expires_at)
        VALUES (repeat('a',64),gen_random_uuid(),gen_random_uuid(),'\\x01','\\x02',now())`);
      await database.query(`CREATE TABLE beeline_room_read_marks (room_id uuid)`);
      await migrate(database);
      const tables = await database.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname='public'
           AND tablename IN ('beeline_agent_connect_grants','beeline_materializer_reservations',
             'beeline_room_read_marks','beeline_agent_pairing_claims',
             'beeline_agent_pairing_claim_memberships','beeline_nip05_names',
             'beeline_github_handle_reservations','google_oauth_accounts','google_oauth_attempts',
             'mission_authority','workflow_owner_transfers','legacy_room_events','import_runs',
             'import_items','feedback_issue_comments','service_review_notice_deliveries')
         ORDER BY 1`,
      );
      expect(tables.rows.map((row) => row.name)).toEqual(['beeline_agent_connect_grants']);
      expect((await database.query(`SELECT 1 FROM beeline_agent_connect_grants`)).rowCount).toBe(1);
    } finally {
      await database.close();
    }
  });
});
