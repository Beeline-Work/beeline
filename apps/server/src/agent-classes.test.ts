import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import {
  agentCarriesTag,
  isConfiguredReviewer,
  loadAgentClassFacts,
  pickHealthyClassMember,
  readWorkspaceWeightTierRulesView,
  roomHasTaggedMember,
  roomMembersWithTag,
} from './agent-classes.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000002';
const ROOM = '20000000-0000-4000-8000-000000000002';
const PARENT = '20000000-0000-4000-8000-000000000003';
const OWNER = 'a'.repeat(64);
const HEAVY_ONE = 'b'.repeat(64);
const HEAVY_TWO = 'c'.repeat(64);
const LIGHT_ONE = 'd'.repeat(64);

let database: PgliteDatabase;

async function reportPresence(agentId: string, status: 'online' | 'offline', ageSeconds = 0) {
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,now() - make_interval(secs => $4))
     ON CONFLICT(room_id,agent_id,turn_id,kind)
     DO UPDATE SET body=EXCLUDED.body,updated_at=EXCLUDED.updated_at`,
    [
      ROOM,
      agentId,
      JSON.stringify({ status, observedAt: Math.floor(Date.now() / 1000) - ageSeconds }),
      ageSeconds,
    ],
  );
}

/** A failed turn plus its `turn-failed` card, as `turn-silence-notice.ts` writes them. */
async function reportFailure(
  agentId: string,
  silenceKind: string,
  ageSeconds = 0,
  roomId = ROOM,
) {
  const requestId = `req-${agentId}-${Math.random().toString(16).slice(2)}`;
  await database.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at)
     VALUES($1,$2,$3,'failed',now() - make_interval(secs => $4))`,
    [roomId, requestId, agentId, ageSeconds],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card,created_at)
     VALUES($1,$2,$3,'failed','turn-failed',$4::jsonb,now() - make_interval(secs => $5))`,
    [
      `${requestId}-card`,
      roomId,
      agentId,
      JSON.stringify({ requestId, agentId, state: 'failed', silenceKind }),
      ageSeconds,
    ],
  );
}

async function reportSuccess(agentId: string, ageSeconds = 0, roomId = ROOM) {
  const requestId = `req-${agentId}-${Math.random().toString(16).slice(2)}`;
  await database.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at)
     VALUES($1,$2,$3,'complete',now() - make_interval(secs => $4))`,
    [roomId, requestId, agentId, ageSeconds],
  );
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'agent','HeavyOne'),($3,'agent','HeavyTwo'),($4,'agent','LightOne')`,
    [OWNER, HEAVY_ONE, HEAVY_TWO, LIGHT_ONE],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Team'),($4,$2,$3,'Parent')`,
    [ROOM, WORKSPACE, OWNER, PARENT],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member'),
       ($1,$7,$3,'owner'),($1,$7,$4,'member'),($1,$7,$5,'member'),($1,$7,$6,'member')`,
    [WORKSPACE, ROOM, OWNER, HEAVY_ONE, HEAVY_TWO, LIGHT_ONE, PARENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
       ($1,$2,'opus-4-5'),($3,$2,'opus-4-5'),($4,$2,'some-light-model')`,
    [HEAVY_ONE, OWNER, HEAVY_TWO, LIGHT_ONE],
  );
});

describe('loadAgentClassFacts / agentCarriesTag', () => {
  it('derives the weight tier from the workspace rules and reports the model as a tag', async () => {
    const facts = await loadAgentClassFacts(database, WORKSPACE, [HEAVY_ONE, LIGHT_ONE]);
    expect(facts.get(HEAVY_ONE)).toMatchObject({ model: 'opus-4-5', weightTier: 'heavy' });
    expect(facts.get(LIGHT_ONE)).toMatchObject({ model: 'some-light-model', weightTier: 'light' });
    expect(await agentCarriesTag(database, WORKSPACE, HEAVY_ONE, 'heavy')).toBe(true);
    expect(await agentCarriesTag(database, WORKSPACE, LIGHT_ONE, 'heavy')).toBe(false);
    expect(await agentCarriesTag(database, WORKSPACE, HEAVY_ONE, 'opus-4-5')).toBe(true);
  });

  it('reads a workspace-custom weight tier map when one is set', async () => {
    await database.query(`UPDATE workspaces SET weight_tier_rules=$2::jsonb WHERE id=$1`, [
      WORKSPACE,
      JSON.stringify([{ pattern: 'opus*', tier: 'light' }]),
    ]);
    const rules = await readWorkspaceWeightTierRulesView(database, WORKSPACE);
    expect(rules.rules).toEqual([{ pattern: 'opus*', tier: 'light' }]);
    expect(await agentCarriesTag(database, WORKSPACE, HEAVY_ONE, 'light')).toBe(true);
    expect(await agentCarriesTag(database, WORKSPACE, HEAVY_ONE, 'heavy')).toBe(false);
  });
});

describe('roomMembersWithTag / roomHasTaggedMember healthy filtering', () => {
  it('excludes an offline candidate', async () => {
    await reportPresence(HEAVY_ONE, 'online');
    await reportPresence(HEAVY_TWO, 'offline');
    const members = await roomMembersWithTag(database, ROOM, WORKSPACE, 'heavy');
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.agentId === HEAVY_ONE)).toMatchObject({ healthy: true });
    expect(members.find((m) => m.agentId === HEAVY_TWO)).toMatchObject({
      healthy: false,
      reason: 'offline',
    });
  });

  it('excludes a candidate that failed within the last few minutes', async () => {
    await reportPresence(HEAVY_ONE, 'online');
    await reportPresence(HEAVY_TWO, 'online');
    await reportFailure(HEAVY_TWO, 'not-signed-in', 30);
    const members = await roomMembersWithTag(database, ROOM, WORKSPACE, 'heavy');
    expect(members.find((m) => m.agentId === HEAVY_TWO)).toMatchObject({
      healthy: false,
      reason: 'recent-failure',
    });
  });

  it('a generic failure clears after the recent-failure window', async () => {
    await reportPresence(HEAVY_ONE, 'online');
    await reportPresence(HEAVY_TWO, 'online');
    await reportFailure(HEAVY_TWO, 'wrong-model', 10 * 60);
    const members = await roomMembersWithTag(database, ROOM, WORKSPACE, 'heavy');
    expect(members.find((m) => m.agentId === HEAVY_TWO)).toMatchObject({ healthy: true });
  });

  it('excludes an out-of-credit candidate regardless of how long ago it failed', async () => {
    await reportPresence(HEAVY_ONE, 'online');
    await reportPresence(HEAVY_TWO, 'online');
    await reportFailure(HEAVY_TWO, 'allowance-spent', 60 * 60);
    const members = await roomMembersWithTag(database, ROOM, WORKSPACE, 'heavy');
    expect(members.find((m) => m.agentId === HEAVY_TWO)).toMatchObject({
      healthy: false,
      reason: 'out-of-credit',
    });
  });

  it('a later success clears a standing out-of-credit mark', async () => {
    await reportPresence(HEAVY_ONE, 'online');
    await reportPresence(HEAVY_TWO, 'online');
    await reportFailure(HEAVY_TWO, 'allowance-spent', 60 * 60);
    await reportSuccess(HEAVY_TWO, 30 * 60);
    const members = await roomMembersWithTag(database, ROOM, WORKSPACE, 'heavy');
    expect(members.find((m) => m.agentId === HEAVY_TWO)).toMatchObject({ healthy: true });
  });

  it('roomHasTaggedMember ignores health — existence only', async () => {
    await reportPresence(HEAVY_ONE, 'offline');
    await reportPresence(HEAVY_TWO, 'offline');
    expect(await roomHasTaggedMember(database, ROOM, WORKSPACE, 'heavy')).toBe(true);
    expect(await roomHasTaggedMember(database, ROOM, WORKSPACE, 'god')).toBe(false);
  });
});

describe('pickHealthyClassMember', () => {
  it('returns null when every class member is unhealthy (exhausted)', async () => {
    await reportPresence(HEAVY_ONE, 'offline');
    await reportPresence(HEAVY_TWO, 'offline');
    expect(await pickHealthyClassMember(database, ROOM, WORKSPACE, 'heavy')).toBeNull();
  });

  it('picks the one remaining healthy candidate', async () => {
    await reportPresence(HEAVY_ONE, 'offline');
    await reportPresence(HEAVY_TWO, 'online');
    expect(await pickHealthyClassMember(database, ROOM, WORKSPACE, 'heavy')).toBe(HEAVY_TWO);
  });

  it('excludes an explicitly named candidate even if healthy', async () => {
    await reportPresence(HEAVY_ONE, 'online');
    await reportPresence(HEAVY_TWO, 'online');
    const picked = await pickHealthyClassMember(database, ROOM, WORKSPACE, 'heavy', [HEAVY_ONE]);
    expect(picked).toBe(HEAVY_TWO);
  });
});

describe('isConfiguredReviewer', () => {
  it('matches an exact fixed reviewer id and rejects anyone else', async () => {
    await database.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [PARENT, HEAVY_ONE]);
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, HEAVY_ONE)).toBe(true);
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, HEAVY_TWO)).toBe(false);
  });

  it('matches any current member carrying a configured class tag', async () => {
    await database.query(`UPDATE rooms SET reviewer_class=$2 WHERE id=$1`, [PARENT, 'heavy']);
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, HEAVY_ONE)).toBe(true);
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, HEAVY_TWO)).toBe(true);
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, LIGHT_ONE)).toBe(false);
  });

  it('rejects a class match from an agent no longer a member of the parent Room', async () => {
    await database.query(`UPDATE rooms SET reviewer_class=$2 WHERE id=$1`, [PARENT, 'heavy']);
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [PARENT, HEAVY_ONE],
    );
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, HEAVY_ONE)).toBe(false);
  });

  it('is false with no reviewer configured at all', async () => {
    expect(await isConfiguredReviewer(database, PARENT, WORKSPACE, HEAVY_ONE)).toBe(false);
  });
});
