import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import type { RouterSnapshot } from '@beeline/api-contract/router-protocol';
import { migrate, PostgresDatabase } from './database.js';
import { PhoneService } from './phone-service.js';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { routerSourcePlan } from './router-source-plan.js';
import { MODEL, MODEL_CLAIM, MODEL_OWNER, MODEL_ROOM, MODEL_WORKSPACE, seedOwnedModelFixture } from './test-fixtures/owned-model.js';

const url = process.env.BEELINE_MIGRATION_LOCK_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Router migration proof requires isolated loopback PostgreSQL');

it.skipIf(!url)('runs release migration twice then serves Tray and owned models without fixture DDL', async () => {
  const schema = `router_release_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const db = new PostgresDatabase('', 1, { mode: 'migration', pool: new Pool({
    connectionString: url, max: 1, options: `-c search_path=${schema},public`,
  }) });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(db);
    await migrate(db);

    const { credentials, actor, issued } = await seedOwnedModelFixture(db, { installSchema: false });
    expect(await db.transaction(tx => credentials.issueInTransaction(tx, MODEL_CLAIM))).toEqual(issued);
    const attempts = new OwnedModelAttempts(db, credentials), requestId = randomUUID();
    const payload = { model: MODEL, messages: [], max_tokens: 8 };
    const admitted = await attempts.reserve(actor, requestId, payload, async () => ({
      reservation: { day: '2026-11-04', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 }, payload,
    }));
    expect(admitted.receipt.state).toBe('unknown');
    await expect(db.query(`UPDATE agent_commands SET generation_id='new-generation' WHERE id=$1`,
      [MODEL_CLAIM.commandId])).rejects.toThrow('UNKNOWN blocks a new command generation');
    const dispatched = await attempts.handoff(admitted.permit!, async body => JSON.parse(body));
    expect(dispatched.state).toBe('started');
    expect(await dispatched.completion).toEqual(payload);
    expect(await attempts.settleUsage(actor, requestId, { tokens: 3, usd: 0.001 }, 'succeeded', async () => {}))
      .toMatchObject({ requestId, state: 'succeeded' });

    const author = 'd'.repeat(64), messageId = 'e'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Author','author')`, [author]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [MODEL_WORKSPACE, MODEL_ROOM, MODEL_OWNER]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Saved text')`, [messageId, MODEL_ROOM, author]);
    const phone = new PhoneService(db, 'https://synthetic.invalid');
    const read = (): Promise<RouterSnapshot<'needs-you-tray'>> => phone.readRouterSnapshot(
      { family: 'needs-you-tray', workspaceId: MODEL_WORKSPACE }, MODEL_OWNER) as Promise<RouterSnapshot<'needs-you-tray'>>;
    await phone.execute('setMessageBookmark', { roomId: MODEL_ROOM, messageId, bookmarked: true }, MODEL_OWNER);
    const saved = (await read()).value.saved.rows[0]!;
    expect(saved.value).toMatchObject({ messageId, text: 'Saved text', available: true });
    await db.query(`UPDATE messages SET text='Edited text' WHERE id=$1`, [messageId]);
    await db.query(`UPDATE identities SET name='Renamed author' WHERE id=$1`, [author]);
    expect((await read()).value.saved.rows[0]!.value).toMatchObject({ text: 'Edited text', author: { name: 'Renamed author' } });
    const causes = (await db.query<{ event: Record<string, unknown> }>(`SELECT event FROM live_journal
      WHERE event->>'sourceTable' IN ('tray-saved-window','tray-saved-source','tray-projection')
        AND event->>'trayReaderId'=$1 ORDER BY sequence`, [MODEL_OWNER])).rows.map(row => row.event);
    expect(new Set(causes.map(cause => cause.sourceTable))).toEqual(new Set([
      'tray-saved-window', 'tray-saved-source', 'tray-projection',
    ]));
    expect(routerSourcePlan(causes, MODEL_OWNER, MODEL_WORKSPACE).families.has('needs-you-tray')).toBe(true);
    // Re-running release DDL preserves persisted credential, attempt and
    // bookmark identity instead of resetting the live router's source rows.
    const before = (await read()).value.saved.rows;
    await migrate(db);
    expect((await read()).value.saved.rows).toEqual(before);
    expect(await credentials.authenticate(db, issued.token)).toBeTruthy();
    expect((await db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'succeeded' }]);
    await phone.execute('clearMessageBookmarks', { workspaceId: MODEL_WORKSPACE }, MODEL_OWNER);
    expect((await read()).value.saved.rows).toEqual([]);
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}, 60_000);
