// Isolated INSTALL-SYNC-1 stand-in: provider fixture -> built webhook operation -> stored access.
import assert from 'node:assert/strict';
import { GitHubOperations } from '../apps/server/dist/github-operations.js';
import { migrate } from '../apps/server/dist/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';

const database = new PgliteDatabase();
const owner = 'a'.repeat(64);
try {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [owner]);
  await database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active')`, [owner]);
  await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(102,77,'owner/removed','main')`);
  const query = database.query.bind(database);
  let writes = 0;
  database.query = async (sql, values) => {
    if (sql.startsWith('INSERT INTO github_repositories(') && ++writes === 1)
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    return query(sql, values);
  };
  const app = {
    installationAccount: async () => ({ id: '42', login: 'owner', type: 'User', repositorySelection: 'selected' }),
    listRepositories: async () => [{ id: 101, installationId: 77, fullName: 'owner/widgets', defaultBranch: 'main', private: false, allowAutoMerge: false }],
  };
  const operations = new GitHubOperations(database, {}, app, 'isolated-proof');
  await operations.processWebhook('installation', { action: 'created', installation: { id: 77 } });
  assert.equal(writes, 2);
  assert.deepEqual((await query(`SELECT repository_id,active FROM github_repositories ORDER BY repository_id`)).rows,
    [{ repository_id: 101, active: true }, { repository_id: 102, active: false }]);
  console.log('INSTALL-SYNC-1 PASS: webhook recovers deadlock; listed repository active, removed repository inactive.');
} finally {
  await database.close();
}
