import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { GitHubOperations } from './github-operations.js';
import { postRepositoryOnboarding } from './repository-onboarding.js';
import { recordPersonMergeYes } from './corner-merge-approval.js';
import { REVIEW_IDENTITY_ID } from './review-access.js';

let db: PgliteDatabase, auth: TokenAuth, phone: PhoneService, github: GitHubOperations;
let owner: string, member: string, workspaceId: string, roomId: string;
const agent = 'b'.repeat(64);
const installationToken = vi.fn(async () => ({ token: 'room-grant', expiresAt: Date.now() + 3_600_000 }));

beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await new AuthStore(db as unknown as TransactionalDatabase).migrate();
  auth = new TokenAuth(db, async () => { throw new Error('GitHub sign-in must not be needed'); },
    () => new Date(), async subject => ({ subject, name: subject, email: `${subject}@gmail.com`, audience: 'google-test' }));
  owner = (await auth.exchangeGoogleOidc('alex.chen')).identityId;
  member = (await auth.exchangeGoogleOidc('sam')).identityId;
  github = new GitHubOperations(db, {} as GitHubOAuthClient, { installationToken } as unknown as GitHubAppClient, 'test-secret');
  phone = new PhoneService(db, 'https://server.test', github);
  const workspace = await phone.execute('createWorkspace', { name: 'Google Workspace' }, owner);
  workspaceId = workspace.id;
  roomId = workspace.roomId!;
  const invite = await phone.execute('createInvite', { workspaceId }, owner);
  await phone.execute('redeemInvite', { token: invite.token }, member);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Beebee','beebee')`, [agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, member]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspaceId, agent, roomId]);
});
afterEach(async () => { vi.unstubAllEnvs(); installationToken.mockClear(); await db.close(); });

async function linkRoom() {
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'admin','User','all','active')`, [owner]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active) VALUES(42,77,'admin/project','main',true)`);
  await phone.execute('setRoomRepository', { roomId, key: 'github:42', name: 'admin/project', remote: 'git://github.com/admin/project', targetBranch: 'main', githubInstallationId: 77 }, owner);
}

it('E1: a Google owner creates a Workspace, general Room, another Room and an invite', async () => {
  expect((await phone.readRoom(roomId, owner))?.room.name).toBe('general');
  const room = await phone.execute('createRoom', { workspaceId, name: 'planning' }, owner);
  expect((await phone.readRoom(room.id, owner))?.room.name).toBe('planning');
  expect((await phone.execute('createInvite', { workspaceId }, owner)).token).toBeTruthy();
  expect((await db.query(`SELECT github_subject FROM identities WHERE id=$1`, [owner])).rows[0]?.github_subject).toBeNull();
});

it('E2: a newly signed-in Google user redeems an existing Workspace invite', async () => {
  expect(await phone.readRoom(roomId, member)).toBeTruthy();
  expect((await db.query(`SELECT role FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [workspaceId, member])).rows[0]?.role).toBe('member');
});

it('E9: the Google member sees a read-only card naming the owner and cannot start GitHub installation', async () => {
  const card = await postRepositoryOnboarding(db, github, { roomId, agentId: agent, requesterId: member, kind: 'repository' });
  expect(card).toMatchObject({ canLink: false, ownerHandle: 'alex.chen', githubLinked: false, repositories: [] });
  await expect(phone.execute('actOnRepositoryCard', { roomId, cardId: card.id, action: 'install', redirectUri: 'beeline://beeline/github-installation' }, member)).rejects.toThrow();
});

it('E10: a Google member opens a corner on another manager’s repo and uses its Room grant', async () => {
  await linkRoom();
  const corner = await phone.execute('createHumanCorner', { roomId, title: 'google-member-work' }, member);
  expect(await phone.readRoom(corner.id, member)).toBeTruthy();
  expect(await github.roomToken(roomId)).toMatchObject({ token: 'room-grant' });
  expect(installationToken).toHaveBeenCalledWith(77, { repositoryIds: [42] });
  expect((await db.query(`SELECT 1 FROM identity_external_links WHERE provider='github' AND identity_id=$1`, [member])).rows).toEqual([]);
});

it('E11: a Google owner records the merge yes on the current head; a regular member cannot', async () => {
  const corner = await phone.execute('createHumanCorner', { roomId, title: 'merge-approval' }, owner);
  await db.query(`UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr}',$2::jsonb) WHERE corner_id=$1`, [corner.id, JSON.stringify({ number: 1, headSha: '1'.repeat(40) })]);
  await expect(recordPersonMergeYes(db, corner.id, owner)).resolves.toMatchObject({ recorded: true, headSha: '1'.repeat(40) });
  await expect(recordPersonMergeYes(db, corner.id, member)).rejects.toThrow('owner or admin');
});

it('E12: a Google admin switching another admin’s repo sees only their own installations', async () => {
  await linkRoom();
  await db.query(`UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`, [workspaceId, member]);
  const card = await postRepositoryOnboarding(db, github, { roomId, agentId: agent, requesterId: member, kind: 'repository' });
  expect(card.canLink).toBe(true);
  expect(card.repositories).toEqual([]);
  expect(card.installationId).toBeUndefined();
  expect(card.githubLinked).toBe(false);
});

it('E17: deleting a Google account removes both provider links and its GitHub token', async () => {
  await db.query(`UPDATE identities SET github_subject='42' WHERE id=$1`, [member]);
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience) VALUES('github','42',$1,'https://github.com','test')`, [member]);
  await db.query(`INSERT INTO github_user_tokens(subject,encrypted_token) VALUES('42','encrypted-test-value')`);
  await phone.execute('deleteAccount', {}, member);
  expect((await db.query(`SELECT 1 FROM identity_external_links WHERE identity_id=$1`, [member])).rows).toEqual([]);
  expect((await db.query(`SELECT 1 FROM github_user_tokens WHERE subject='42'`)).rows).toEqual([]);
});

it('E18: the review identity remains blocked from repo and bind operations', async () => {
  await expect(phone.execute('beginGitHubInstallation', { redirectUri: 'beeline://beeline/github-installation' }, REVIEW_IDENTITY_ID)).rejects.toThrow('review identity');
  await expect(phone.execute('beginGitHubIdentityBind', { redirectUri: 'beeline://beeline/github-callback', state: 's'.repeat(43) }, REVIEW_IDENTITY_ID)).rejects.toThrow('review identity');
  await expect(auth.linkGoogleOidc(REVIEW_IDENTITY_ID, 'unused')).rejects.toThrow('review identity');
});

it('E21: Google owners can issue a helper pairing code without a GitHub account', async () => {
  const pairing = await phone.execute('createAgentPairingCode', { workspaceId }, owner);
  expect(pairing.code).toBeTruthy();
  expect(pairing.expiresAt).toBeGreaterThan(Date.now() / 1000);
});

it.each([true, false])('E5: an existing org installation changes owner only after an explicit admin proof (%s)', async admin => {
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'organization','Organization','all','active')`, [member]);
  const oauth = { exchangeCode: async () => ({subject:'42',login:'alex-dev',issuer:'https://github.com',audience:'test',accessToken:'test-user-grant'}) } as unknown as GitHubOAuthClient;
  const app = {
    installationUrl: (state: string) => `https://github.test/install?state=${state}`,
    installationAccount: async () => ({id:'84',login:'organization',type:'Organization',repositorySelection:'all'}),
    organizationAdmin: async () => admin,
    userCanAccessInstallation: async () => true,
    listRepositories: async () => [],
  } as unknown as GitHubAppClient;
  const operations = new GitHubOperations(db, oauth, app, 'test-secret');
  const started = await operations.beginInstallation(owner, {redirectUri:'beeline://beeline/github-installation'});
  const state = new URL(started.url).searchParams.get('state')!;
  const result = await operations.completeInstallation(state, 77, 'oauth-code', 'https://server.test/auth/github/callback');
  expect(new URL(result).searchParams.get('installed')).toBe(admin ? '1' : '0');
  expect((await db.query(`SELECT owner_id FROM github_installations WHERE installation_id=77`)).rows[0]?.owner_id).toBe(admin ? owner : member);
  expect((await db.query(`SELECT 1 FROM identity_external_links WHERE provider='github' AND identity_id=$1`, [owner])).rows).toHaveLength(admin ? 1 : 0);
});
