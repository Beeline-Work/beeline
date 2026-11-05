import { expect, it } from 'vitest';
import { RouterBuildCoordinator, readRouterBuildTicket } from './router-build-coordinator.js';
import { migratedDatabase } from './test-support.js';

it('re-reads timestamp-dependent Needs-you even when no source write advances its cut', async () => {
  const db = await migratedDatabase();
  try {
    const reader = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader')`, [reader]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [workspace,reader]);
    const coordinator = new RouterBuildCoordinator();
    const input = { family: 'needs-you-count' as const, workspaceId: workspace };
    const basis = { schema: 1 as const, databaseScope: 'local-test', version: 'phone-dto-v1',
      publicOrigin: 'https://example.test', clockVersion: 'stored-timestamps' };
    const first = await db.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return coordinator.build(await readRouterBuildTicket(tx,input,reader,basis), async () => ({ count: 1 }));
    });
    const second = await db.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return coordinator.build(await readRouterBuildTicket(tx,input,reader,basis), async () => ({ count: 0 }));
    });
    expect(first.value).toEqual({ count: 1 });
    expect(second.value).toEqual({ count: 0 });
    expect(first.cut).toEqual(second.cut);
  } finally { await db.close(); }
});
