import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { firstHealthyAgent, isConfiguredReviewer, nextHealthyAgent, roomAgentHealth } from './agent-health.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000002';
const ROOM = '20000000-0000-4000-8000-000000000002';
const PARENT = '20000000-0000-4000-8000-000000000003';
const OWNER = 'a'.repeat(64);
const AGENT_ONE = 'b'.repeat(64);
const AGENT_TWO = 'c'.repeat(64);
const AGENT_THREE = 'd'.repeat(64);

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
       ($1,'human','Owner'),($2,'agent','AgentOne'),($3,'agent','AgentTwo'),($4,'agent','AgentThree')`,
    [OWNER, AGENT_ONE, AGENT_TWO, AGENT_THREE],
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
    [WORKSPACE, ROOM, OWNER, AGENT_ONE, AGENT_TWO, AGENT_THREE, PARENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model) VALUES
       ($1,$2,'opus-4-5'),($3,$2,'opus-4-5'),($4,$2,'some-light-model')`,
    [AGENT_ONE, OWNER, AGENT_TWO, AGENT_THREE],
  );
});

const ALL = () => [AGENT_ONE, AGENT_TWO];

describe('roomAgentHealth', () => {
  it('judges presence by its latest status, never its age', async () => {
    await reportPresence(AGENT_ONE, 'online', 6 * 60 * 60);
    await reportPresence(AGENT_TWO, 'offline', 6 * 60 * 60);
    const health = await roomAgentHealth(database, ROOM, ALL());
    expect(health.get(AGENT_ONE)).toEqual({ healthy: true });
    expect(health.get(AGENT_TWO)).toEqual({ healthy: false, reason: 'offline' });
  });

  it('marks an offline agent unhealthy', async () => {
    await reportPresence(AGENT_ONE, 'online');
    await reportPresence(AGENT_TWO, 'offline');
    const health = await roomAgentHealth(database, ROOM, ALL());
    expect(health.get(AGENT_ONE)).toEqual({ healthy: true });
    expect(health.get(AGENT_TWO)).toEqual({ healthy: false, reason: 'offline' });
  });

  it('marks an agent that failed within the last few minutes unhealthy', async () => {
    await reportPresence(AGENT_ONE, 'online');
    await reportPresence(AGENT_TWO, 'online');
    await reportFailure(AGENT_TWO, 'not-signed-in', 30);
    const health = await roomAgentHealth(database, ROOM, ALL());
    expect(health.get(AGENT_TWO)).toEqual({ healthy: false, reason: 'recent-failure' });
  });

  it('a generic failure clears after the recent-failure window', async () => {
    await reportPresence(AGENT_TWO, 'online');
    await reportFailure(AGENT_TWO, 'wrong-model', 10 * 60);
    expect((await roomAgentHealth(database, ROOM, ALL())).get(AGENT_TWO)).toEqual({ healthy: true });
  });

  it('marks an out-of-credit agent unhealthy regardless of how long ago it failed', async () => {
    await reportPresence(AGENT_TWO, 'online');
    await reportFailure(AGENT_TWO, 'allowance-spent', 60 * 60);
    expect((await roomAgentHealth(database, ROOM, ALL())).get(AGENT_TWO)).toEqual({
      healthy: false,
      reason: 'out-of-credit',
    });
  });

  it('a later success clears a standing out-of-credit mark', async () => {
    await reportPresence(AGENT_TWO, 'online');
    await reportFailure(AGENT_TWO, 'allowance-spent', 60 * 60);
    await reportSuccess(AGENT_TWO, 30 * 60);
    expect((await roomAgentHealth(database, ROOM, ALL())).get(AGENT_TWO)).toEqual({ healthy: true });
  });

  it('leaves out an agent that is not a current member of the Room', async () => {
    await reportPresence(AGENT_ONE, 'online');
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, AGENT_ONE],
    );
    expect((await roomAgentHealth(database, ROOM, ALL())).has(AGENT_ONE)).toBe(false);
  });
});

describe('firstHealthyAgent', () => {
  it('takes the list in order, skipping unhealthy agents', async () => {
    await reportPresence(AGENT_ONE, 'offline');
    await reportPresence(AGENT_TWO, 'online');
    await reportPresence(AGENT_THREE, 'online');
    expect(await firstHealthyAgent(database, ROOM, [AGENT_ONE, AGENT_THREE, AGENT_TWO])).toBe(AGENT_THREE);
    expect(await firstHealthyAgent(database, ROOM, [AGENT_TWO, AGENT_THREE])).toBe(AGENT_TWO);
  });

  it('skips an excluded agent even if healthy', async () => {
    await reportPresence(AGENT_ONE, 'online');
    await reportPresence(AGENT_TWO, 'online');
    expect(await firstHealthyAgent(database, ROOM, ALL(), [AGENT_ONE])).toBe(AGENT_TWO);
  });

  it('returns null when nobody on the list is healthy', async () => {
    await reportPresence(AGENT_ONE, 'offline');
    await reportPresence(AGENT_TWO, 'offline');
    expect(await firstHealthyAgent(database, ROOM, ALL())).toBeNull();
  });
});

describe('nextHealthyAgent', () => {
  it('only looks after the failed agent, never before it', async () => {
    await reportPresence(AGENT_ONE, 'online');
    await reportPresence(AGENT_TWO, 'online');
    await reportPresence(AGENT_THREE, 'online');
    expect(await nextHealthyAgent(database, ROOM, [AGENT_ONE, AGENT_TWO, AGENT_THREE], AGENT_TWO)).toBe(AGENT_THREE);
    expect(await nextHealthyAgent(database, ROOM, [AGENT_ONE, AGENT_TWO, AGENT_THREE], AGENT_THREE)).toBeNull();
  });

  it('starts from the top for an agent not on the list', async () => {
    await reportPresence(AGENT_ONE, 'online');
    await reportPresence(AGENT_TWO, 'online');
    expect(await nextHealthyAgent(database, ROOM, [AGENT_ONE, AGENT_TWO], AGENT_THREE)).toBe(AGENT_ONE);
  });
});

describe('isConfiguredReviewer', () => {
  it('matches the reviewer and rejects anyone else', async () => {
    await database.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [PARENT, AGENT_ONE]);
    expect(await isConfiguredReviewer(database, PARENT, AGENT_ONE)).toBe(true);
    expect(await isConfiguredReviewer(database, PARENT, AGENT_TWO)).toBe(false);
  });

  it('matches a fallback reviewer that is a current member of the Room', async () => {
    await database.query(`UPDATE rooms SET reviewer_agent_id=$2,reviewer_fallback_ids=$3 WHERE id=$1`, [
      PARENT,
      AGENT_ONE,
      [AGENT_TWO],
    ]);
    expect(await isConfiguredReviewer(database, PARENT, AGENT_TWO)).toBe(true);
    expect(await isConfiguredReviewer(database, PARENT, AGENT_THREE)).toBe(false);
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [PARENT, AGENT_TWO],
    );
    expect(await isConfiguredReviewer(database, PARENT, AGENT_TWO)).toBe(false);
  });

  it('ignores fallbacks left behind without a reviewer', async () => {
    await database.query(`UPDATE rooms SET reviewer_fallback_ids=$2 WHERE id=$1`, [PARENT, [AGENT_TWO]]);
    expect(await isConfiguredReviewer(database, PARENT, AGENT_TWO)).toBe(false);
  });

  it('is false with no reviewer configured at all', async () => {
    expect(await isConfiguredReviewer(database, PARENT, AGENT_ONE)).toBe(false);
  });
});
