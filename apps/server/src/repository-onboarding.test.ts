import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import type { GitHubOperations } from './github-operations.js';
import { postRepositoryOnboarding, repositoryStarters, type RepositorySignals } from './repository-onboarding.js';

const H = 'a'.repeat(64), A = 'b'.repeat(64), OTHER = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase, phone: PhoneService;
const signals: RepositorySignals = { commits: [], failingChecks: [], issues: [], branches: [], files: [] };
const github = { onboardingSignals: vi.fn(async () => signals), refresh: vi.fn(async () => ({})),
  createRepository: vi.fn(async (_viewer: string, input: { name: string }, database: SqlDatabase) => {
    await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active) VALUES(100,77,$1,'main',true)`, [`tester/${input.name}`]);
    return { id:100, fullName:`tester/${input.name}`, installationId:77, defaultBranch:'main', private:true };
  }),
} as unknown as GitHubOperations;

beforeAll(async () => {
  db = new PgliteDatabase();

  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Test','tester'),($2,'agent','Beebee','beebee'),($3,'human','Other','other')`, [H,A,OTHER]);
  await db.query(`UPDATE identities SET github_subject=CASE WHEN id=$1 THEN '296966200' ELSE '123' END WHERE id IN ($1,$2)`, [H,OTHER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Onboarding test')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'general',$3)`, [R,W,H]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
  for (const identity of [H,A]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [W,identity,R]);
  }
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'tester','User','all','active')`, [H]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active) VALUES(42,77,'tester/project','main',true),(43,77,'tester/other','main',true)`);
  phone = new PhoneService(db, 'https://server.test', github);
}, 30_000);
afterAll(async () => { await db?.close(); });

it('grounds tasks in observed signals and provides three useful empty-repo starters', () => {
  expect(repositoryStarters(signals)).toHaveLength(3);
  const tasks = repositoryStarters({ ...signals, failingChecks: ['unit-tests'],
    issues: [{ number: 12, title: 'Navigation overlaps', bug: true }],
    commits: [{ sha: 'abc', message: 'pricing', files: ['src/pricing.ts'] }],
    branches: ['wip-dark-mode'], files: ['src/pricing.ts'] });
  expect(tasks.map(t => t.id)).toEqual(['ci','issue-12','tests','wip']);
  expect(tasks[2]!.evidence).toContain('1 sampled commits');
});

it('shows installation missing for an account without an installation', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`, [W,OTHER]);
  const card = await postRepositoryOnboarding(db, undefined, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  expect(card.state).toBe('install_missing');
  expect(card.ownerHandle).toBe('tester');
  expect(card.canLink).toBe(false);
  await expect(phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'install', redirectUri:'beeline://beeline/github-installation' }, OTHER)).rejects.toThrow();
  await expect(phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'link', repositoryId:42 }, OTHER)).rejects.toThrow();
});

it('links from the card, displays starters, starts the selected task once and switches without touching open work', async () => {
  const card = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  expect(card.state).toBe('no_repo_linked');
  const before = await phone.readRoom(R,H);
  expect(before?.messages.find(message => message.id === card.id)?.onboarding?.repositories).toHaveLength(2);
  await phone.execute('actOnRepositoryCard', { roomId:R, cardId:card.id, action:'link', repositoryId:42 }, H);
  const linked = await phone.readRoom(R,H);
  const starters = linked?.messages.find(message => message.onboarding?.kind === 'starters')?.onboarding;
  expect(starters?.repository).toBe('tester/project');
  expect(starters?.starters).toHaveLength(3);
  const select = { roomId:R, cardId:starters!.id, action:'starter' as const, starterId:'readme' };
  await phone.execute('actOnRepositoryCard', select, H);
  await phone.execute('actOnRepositoryCard', select, H);
  expect((await db.query(`SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 AND text LIKE '%Make the README useful%'`, [R,H])).rowCount).toBe(1);
  const corner='33333333-3333-4333-8333-333333333333';
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,$3,'open-work','github:42','tester/project','git://github.com/tester/project','repository',77)`, [corner,W,R]);
  await db.query(`INSERT INTO corner_facts(corner_id,commissioned_by,lifecycle) VALUES($1,$2,'{"pr":{"number":17,"url":"https://github.com/tester/project/pull/17"}}')`, [corner,H]);
  const switchCard = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  expect(switchCard.repositories.find(r => r.id === 42)?.current).toBe(true);
  await phone.execute('actOnRepositoryCard', { roomId:R, cardId:switchCard.id, action:'link', repositoryId:43 }, H);
  expect((await phone.readRoom(R,H))?.repository?.name).toBe('tester/other');
  expect((await db.query(`SELECT repository_name FROM rooms WHERE id=$1`,[corner])).rows[0]?.repository_name).toBe('tester/project');
  expect((await db.query(`SELECT lifecycle->'pr'->>'url' url FROM corner_facts WHERE corner_id=$1`,[corner])).rows[0]?.url).toBe('https://github.com/tester/project/pull/17');
  expect((await db.query(`SELECT count(*)::int count FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [R,A])).rows[0]?.count).toBe(1);
});

it('keeps the linked card retryable when GitHub signals fail after the binding commits', async () => {
  const card = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  vi.mocked(github.onboardingSignals).mockRejectedValueOnce(new Error('GitHub temporarily unavailable'));
  const tap = { roomId:R, cardId:card.id, action:'link' as const, repositoryId:42 };
  await expect(phone.execute('actOnRepositoryCard', tap, H)).rejects.toThrow('temporarily unavailable');
  expect((await phone.readRoom(R,H))?.repository?.name).toBe('tester/project');
  expect((await phone.readRoom(R,H))?.messages.find(m => m.id === card.id)?.onboarding?.status).toBe('open');
  await expect(phone.execute('actOnRepositoryCard', { ...tap, repositoryId:43 }, H)).rejects.toThrow('already linked');
  await phone.execute('actOnRepositoryCard', tap, H);
  expect((await phone.readRoom(R,H))?.messages.find(m => m.id === card.id)?.onboarding?.status).toBe('settled');
});

it('creates and links a private repository once when the same tap is retried', async () => {
  const card=await postRepositoryOnboarding(db,github,{roomId:R,agentId:A,requesterId:H,kind:'repository'});
  const tap={roomId:R,cardId:card.id,action:'create' as const};
  await phone.execute('actOnRepositoryCard',tap,H);
  await phone.execute('actOnRepositoryCard',tap,H);
  expect(github.createRepository).toHaveBeenCalledTimes(1);
  expect((await phone.readRoom(R,H))?.repository?.name).toBe(`tester/${card.defaultName}`);
});

it('lets an invited Room member start work without granting repository-management rights', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[W,R,OTHER]);
  const card=await postRepositoryOnboarding(db,github,{roomId:R,agentId:A,requesterId:OTHER,kind:'starters'});
  expect(card.canLink).toBe(false);
  await phone.execute('actOnRepositoryCard',{roomId:R,cardId:card.id,action:'starter',starterId:'readme'},OTHER);
  expect((await db.query(`SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 AND text LIKE '%Make the README useful%'`,[R,OTHER])).rowCount).toBe(1);
});

it('advertises cards to Google-only viewers without feature configuration', async () => {
  expect(await phone.execute('getAuthCapabilities', {}, OTHER)).toHaveProperty('repositoryOnboarding', true);
  const card = await postRepositoryOnboarding(db, undefined, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  expect((await phone.readRoom(R, H))?.messages.some(message => message.id === card.id)).toBe(true);
});

it('keeps another requester\'s unanswered card open when onboarding an invitee', async () => {
  const ownerCard = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:H, kind:'repository' });
  const inviteeCard = await postRepositoryOnboarding(db, github, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  const cards = (await db.query<{ id: string; status: string }>(
    `SELECT id,card->>'status' status FROM messages WHERE id=ANY($1::text[])`, [[ownerCard.id, inviteeCard.id]])).rows;
  expect(cards).toHaveLength(2);
  expect(cards.every(card => card.status === 'open')).toBe(true);
});

it('E19/E20: allows any Google-only identity without configuration', async () => {
  await db.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [OTHER]);
  const card = await postRepositoryOnboarding(db, undefined, { roomId:R, agentId:A, requesterId:OTHER, kind:'repository' });
  expect(card.githubLinked).toBe(false);
  expect(card.repositories).toEqual([]);
});
