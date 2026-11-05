import { expect, it } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { type SqlDatabase } from './database.js';
import { migratedDatabase } from './test-support.js';

it('finishes an earlier slow suspension before a later installation deletion', async () => {
  let suspended!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { suspended = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let status = 'active';
  let repositoriesActive = true;
  const writes: string[] = [];
  const database = {
    query: async (sql: string) => {
      if (sql.includes("SET status='suspended'")) {
        suspended();
        await gate;
        status = 'suspended';
        writes.push(status);
      } else if (sql.includes("SET status='revoked'")) {
        status = 'revoked';
        writes.push(status);
      } else if (sql.includes('UPDATE github_repositories SET active=false')) {
        repositoriesActive = false;
        writes.push('repositories inactive');
      } else throw new Error(`unexpected query: ${sql}`);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as SqlDatabase;
  const operations = new GitHubOperations(database, {} as GitHubOAuthClient, {} as GitHubAppClient, 'fixture');
  const first = operations.processWebhook('installation', { action: 'suspend', installation: { id: 77 } });
  await started;
  const second = operations.processWebhook('installation', { action: 'deleted', installation: { id: 77 } });
  // Let the later delivery run if admission incorrectly allows it to overtake.
  await new Promise<void>(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  expect(writes).toEqual(['suspended', 'revoked', 'repositories inactive']);
  expect(status).toBe('revoked');
  expect(repositoriesActive).toBe(false);
});


it('keeps revocation terminal when the delayed suspension runs on another server instance', async () => {
  const database = await migratedDatabase();
  try {
    const owner = 'a'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [owner]);
    await database.query(`INSERT INTO github_installations(
      installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
    ) VALUES(77,$1,'42','owner','User','selected','active')`, [owner]);
    await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(101,77,'owner/widgets','main')`);
    let suspended!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { suspended = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = {
      ...database,
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("SET status='suspended'")) { suspended(); await gate; }
        return database.query(sql, values);
      },
    } as unknown as SqlDatabase;
    const firstServer = new GitHubOperations(slow, {} as GitHubOAuthClient, {} as GitHubAppClient, 'fixture');
    const secondServer = new GitHubOperations(database, {} as GitHubOAuthClient, {} as GitHubAppClient, 'fixture');
    const first = firstServer.processWebhook('installation', { action: 'suspend', installation: { id: 77 } });
    await started;
    await secondServer.processWebhook('installation', { action: 'deleted', installation: { id: 77 } });
    release();
    await first;
    expect((await database.query(`SELECT status FROM github_installations WHERE installation_id=77`)).rows)
      .toEqual([{ status: 'revoked' }]);
    expect((await database.query(`SELECT active FROM github_repositories WHERE repository_id=101`)).rows)
      .toEqual([{ active: false }]);
  } finally { await database.close(); }
});

it('releases webhook admission after an ignored delivery or a failed database write', async () => {
  let fail = true;
  const writes: string[] = [];
  const database = {
    query: async (sql: string) => {
      if (fail) { fail = false; throw new Error('write failed'); }
      writes.push(sql);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as SqlDatabase;
  const operations = new GitHubOperations(database, {} as GitHubOAuthClient, {} as GitHubAppClient, 'fixture');
  await operations.processWebhook('installation', null);
  await expect(operations.processWebhook('installation', { action: 'suspend', installation: { id: 77 } }))
    .rejects.toThrow('write failed');
  await operations.processWebhook('installation', { action: 'deleted', installation: { id: 77 } });
  expect(writes).toHaveLength(2);
  expect(writes[0]).toContain("SET status='revoked'");
  expect(writes[1]).toContain('UPDATE github_repositories SET active=false');
});
