import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migratedDatabase } from "../../../tests/helpers/server.js";
import { dispatchPromptReplay, isPromptInput } from './prompt-replay.js';
import { GitHubOperations } from './github-operations.js';
const OWNER = 'a'.repeat(64), BABY = 'b'.repeat(64), TERRA = 'c'.repeat(64), SPEEDY = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
const head = 'a'.repeat(40);
const request = { repository: 'Beeline-Work/beeline', installationId: 77, number: 7, head };
async function fixture() {
  const db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),
    ($2,'agent','Baby','baby'),($3,'agent','Terra','terra'),($4,'agent','Speedy','speedy')`, [OWNER, BABY, TERRA, SPEEDY]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [BABY, TERRA, SPEEDY, OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Replay fixture')`, [WORKSPACE]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status)
    VALUES(77,$1,'Beeline-Work','Organization','active')`, [OWNER]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(101,77,'Beeline-Work/beeline','main')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,github_installation_id)
    VALUES($1,$2,$3,'Agents','Beeline-Work/beeline',77)`, [ROOM, WORKSPACE, OWNER]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, OWNER]);
  for (const who of [OWNER, BABY, TERRA, SPEEDY]) await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, who]);
  for (const who of [BABY, TERRA, SPEEDY]) await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [ROOM, who]);
  const app = { installationToken: vi.fn(async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' })),
    readPullRequest: vi.fn(async () => ({ state: 'open', headSha: head })),
    readPullRequestFiles: vi.fn(async () => ({ complete: true, files: [{ filename: 'apps/body/src/prompt-assembly.ts' }] })),
  };
  const run = () => dispatchPromptReplay(db, app as unknown as GitHubAppClient, request);
  return { db, app, run };
}
it('covers every PROMPT CASES input, including replay scripts', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/prompt-cases.yml', import.meta.url), 'utf8');
  for (const pattern of [...workflow.matchAll(/^\s+- '([^']+)'$/gm)].map(match => match[1]!))
    expect(isPromptInput(pattern.replaceAll('**', 'example.json').replaceAll('*', 'example')), pattern).toBe(true);
  expect(isPromptInput('apps/mobile/app.tsx')).toBe(false);
});
it('verified opened/synchronize events dispatch one private order per head with no manual setup', async () => {
  const { db, app } = await fixture();
  try {
    const operations = new GitHubOperations(db, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'fixture');
    for (const action of ['opened', 'synchronize', 'reopened']) await operations.processWebhook('pull_request', {
      action, installation: { id: 77 }, repository: { full_name: 'Beeline-Work/beeline' },
      pull_request: { number: 7, head: { sha: head } },
    }, `delivery-${action}`);
    const commands = (await db.query(`SELECT agent_id,reason,private_payload FROM agent_commands`)).rows;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ agent_id: BABY, reason: 'order', private_payload: { kind: 'order' } });
    expect(commands[0]!.private_payload.text).toContain(head);
    expect(commands[0]!.private_payload.text).toContain('--agent baby');
    expect((await db.query('SELECT 1 FROM messages')).rowCount).toBe(0);
    expect(app.readPullRequestFiles).toHaveBeenCalledOnce();
    expect(app.installationToken).toHaveBeenCalledWith(77, { repositoryIds: [101] });
  } finally { await db.close(); }
});
it('falls back from offline Baby to Terra, then Speedy', async () => {
  const { db, run } = await fixture();
  try {
    await db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [BABY]);
    await run();
    expect((await db.query('SELECT agent_id FROM agent_commands')).rows).toEqual([{ agent_id: TERRA }]);
    await db.query('DELETE FROM agent_commands');
    await db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [TERRA]);
    await run();
    expect((await db.query('SELECT agent_id FROM agent_commands')).rows).toEqual([{ agent_id: SPEEDY }]);
  } finally { await db.close(); }
});
it('ignores unrelated PRs and stale event heads', async () => {
  const { db, app, run } = await fixture();
  try {
    app.readPullRequestFiles.mockResolvedValue({ complete: true, files: [{ filename: 'README.md' }] });
    expect(await run()).toBeUndefined();
    app.readPullRequest.mockResolvedValue({ state: 'open', headSha: 'b'.repeat(40) });
    expect(await run()).toBeUndefined();
    expect((await db.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
  } finally { await db.close(); }
});
it('replays renamed prompt inputs and incomplete file lists conservatively', async () => {
  const { db, app, run } = await fixture();
  try {
    app.readPullRequestFiles.mockResolvedValue({ complete: true, files: [{ filename: 'old.md', previousFilename: 'docs/prompts/cases/removed.json' } as { filename: string }] });
    expect(await run()).toBe(ROOM);
    await db.query('DELETE FROM agent_commands');
    app.readPullRequestFiles.mockResolvedValue({ complete: false, files: [] });
    expect(await run()).toBe(ROOM);
  } finally { await db.close(); }
});
it('head moving while listing files never queues the outdated replay', async () => {
  const { db, app, run } = await fixture();
  try {
    app.readPullRequest.mockResolvedValueOnce({ state: 'open', headSha: head }).mockResolvedValueOnce({ state: 'open', headSha: 'b'.repeat(40) });
    expect(await run()).toBeUndefined();
    expect((await db.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
  } finally { await db.close(); }
});
it('removed membership and mismatched repository binding cannot dispatch', async () => {
  const { db, app, run } = await fixture();
  try {
    await db.query(`UPDATE rooms SET repository_key='another/repository' WHERE id=$1`, [ROOM]);
    expect(await run()).toBeUndefined();
    expect(app.readPullRequestFiles).not.toHaveBeenCalled();
    await db.query(`UPDATE rooms SET repository_key='Beeline-Work/beeline' WHERE id=$1`, [ROOM]);
    await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1', [ROOM]);
    expect(await run()).toBeUndefined();
  } finally { await db.close(); }
});
