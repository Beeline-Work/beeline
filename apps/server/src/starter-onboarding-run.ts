import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SqlDatabase } from './database.js';
import type { FreeAgentModelProxyOptions } from './free-agent-model-proxy.js';
import { completeStarterBanter } from './free-agent-model-proxy.js';
import { generateStarterBanter, starterBanterBeforeDeadline, type BanterAgent, type BanterLine } from './starter-banter.js';
import { postStarterWelcome } from './starter-onboarding.js';
import { recordOnboardingEvent } from './signin-funnel.js';

export const STARTER_ONBOARDING_SCHEMA = `CREATE TABLE IF NOT EXISTS starter_onboarding_runs (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identities(id),
  beebee_id text NOT NULL REFERENCES identities(id),
  luna_id text NOT NULL REFERENCES identities(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','generating','ready','playing','complete')),
  lines jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  opened_at timestamptz,
  playback_claimed_at timestamptz,
  time_zone text NOT NULL DEFAULT 'UTC',
  manual boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS starter_onboarding_room_pending ON starter_onboarding_runs(room_id) WHERE status<>'complete';`;

export async function createStarterOnboardingRun(database: SqlDatabase, input: {
  roomId: string; userId: string; beebeeId: string; lunaId: string; manual?: boolean; timeZone?: string;
}) {
  const id = randomUUID();
  await database.query(`INSERT INTO starter_onboarding_runs(id,room_id,user_id,beebee_id,luna_id,manual,time_zone)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, input.roomId, input.userId, input.beebeeId, input.lunaId, input.manual ?? false, input.timeZone ?? 'UTC']);
  return id;
}

/** Each banter agent shows as typing this long before its line, so the exchange reads like a conversation. */
export const STARTER_BANTER_TYPING_MS = 3500;

/** Generation starts at commit. Entry claims playback across server instances. */
export class StarterOnboardingService {
  private generations = new Map<string, { promise: Promise<BanterLine[] | null>; abort: AbortController }>();
  constructor(private database: SqlDatabase, private model?: FreeAgentModelProxyOptions) {}

  async prepare(roomId: string): Promise<void> {
    const run = (await this.database.query<{ id: string; name: string; time_zone: string }>(
      `UPDATE starter_onboarding_runs SET status='generating' WHERE room_id=$1 AND status='pending'
       RETURNING id,time_zone,(SELECT name FROM identities WHERE id=user_id) name`, [roomId])).rows[0];
    if (!run) return;
    const agents = (await this.database.query<BanterAgent & { starter_role: string }>(
      `SELECT i.id,i.name,i.handle,a.soul->>'instructions' instructions,f.starter_role
       FROM starter_onboarding_runs r JOIN free_agents f ON f.agent_id=ANY(ARRAY[r.beebee_id,r.luna_id])
       JOIN identities i ON i.id=f.agent_id JOIN agents a ON a.agent_id=i.id
       WHERE r.id=$1 AND f.removed_at IS NULL`, [run.id])).rows;
    const beebee = agents.find(agent => agent.starter_role === 'beebee');
    const luna = agents.find(agent => agent.starter_role === 'luna');
    const abort = new AbortController();
    const model = this.model;
    const promise = beebee && luna && model ? generateStarterBanter({
      name: run.name.trim().split(/\s+/u)[0] || 'there',
      time: new Intl.DateTimeFormat('en', { weekday: 'long', hour: 'numeric', minute: 'numeric', timeZone: run.time_zone, timeZoneName: 'short' }).format(new Date()),
      beebee, luna, signal: abort.signal,
      complete: (agent, messages, signal) => completeStarterBanter(model, run.id, agent.id, messages, signal),
    }).catch(() => null) : Promise.resolve(null);
    const expiry = setTimeout(() => abort.abort(), 120_000);
    void promise.finally(() => clearTimeout(expiry));
    this.generations.set(run.id, { promise, abort });
    void promise.then(async lines => {
      await this.database.query(`UPDATE starter_onboarding_runs SET lines=$2::jsonb,status='ready'
        WHERE id=$1 AND status='generating'`, [run.id, JSON.stringify(lines)]);
      this.generations.delete(run.id);
    })
      .catch(error => console.error('[onboarding] generation persistence failed', error));
  }

  open(roomId: string, userId: string): void {
    const work = () => this.enter(roomId, userId)
      .then(() => undefined)
      .catch(error => console.error('[onboarding] playback failed', error));
    // Playback outlives the Room read, so closing the database must drain it.
    if (this.database.backgroundWork) this.database.backgroundWork.run(work);
    else void work();
  }

  async queueRerun(database: SqlDatabase, roomId: string, userId: string, agentId: string) {
    const team = (await database.query<{ beebee_id: string; luna_id: string; time_zone: string }>(
      `SELECT b.agent_id beebee_id,l.agent_id luna_id,COALESCE((SELECT time_zone FROM starter_onboarding_runs
         WHERE user_id=$3 ORDER BY created_at DESC LIMIT 1),'UTC') time_zone FROM free_agents b JOIN free_agents l
       ON l.owner_id=b.owner_id AND l.workspace_id=b.workspace_id AND l.starter_role='luna'
       JOIN memberships bm ON bm.identity_id=b.agent_id AND bm.room_id=$1 AND bm.removed_at IS NULL
       JOIN memberships lm ON lm.identity_id=l.agent_id AND lm.room_id=$1 AND lm.removed_at IS NULL
       WHERE b.agent_id=$2 AND b.starter_role='beebee' AND b.removed_at IS NULL AND l.removed_at IS NULL`, [roomId, agentId, userId])).rows[0];
    if (!team) throw new Error('Onboarding requires Beebee and Luna in this Room');
    await database.query(`UPDATE starter_onboarding_runs SET status='complete' WHERE room_id=$1 AND status<>'complete'`, [roomId]);
    return createStarterOnboardingRun(database, { roomId, userId, beebeeId: team.beebee_id, lunaId: team.luna_id, timeZone: team.time_zone, manual: true });
  }

  async enter(roomId: string, userId: string) {
    const run = (await this.database.query<{ id: string; beebee_id: string; lines: BanterLine[] | null; manual: boolean; opened_at: Date }>(
      `UPDATE starter_onboarding_runs SET lines=CASE WHEN opened_at IS NULL THEN lines ELSE NULL END,opened_at=COALESCE(opened_at,clock_timestamp()),playback_claimed_at=clock_timestamp()
       WHERE room_id=$1 AND user_id=$2 AND (opened_at IS NULL OR playback_claimed_at<clock_timestamp()-interval '35 seconds') AND status<>'complete'
       RETURNING id,beebee_id,lines,manual,opened_at`, [roomId, userId])).rows[0];
    if (!run) return;
    await this.prepare(roomId).catch(error => console.error('[onboarding] using fixed hello', error));
    const generation = this.generations.get(run.id);
    let lines = run.lines;
    if (generation) lines = await starterBanterBeforeDeadline(generation.promise, new Date(run.opened_at).getTime(), generation.abort);
    // A different server may own generation. The server job reads only this one run,
    // and the deadline still bounds entry; phones never poll.
    else while (!lines && Date.now() < new Date(run.opened_at).getTime() + 20_000) {
      const state = (await this.database.query<{ lines: BanterLine[] | null; status: string }>(
        `SELECT lines,status FROM starter_onboarding_runs WHERE id=$1`, [run.id])).rows[0];
      if (!state || state.status === 'ready') { lines = state?.lines ?? null; break; }
      await delay(200);
    }
    this.generations.delete(run.id);
    const active = await this.database.query(`UPDATE starter_onboarding_runs SET status='playing' WHERE id=$1 AND status<>'complete'`, [run.id]);
    if (!active.rowCount) return;
    let choice;
    try {
      if (lines) for (const line of lines) {
        await this.database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
          VALUES($1,$2,$3,'working',$2) ON CONFLICT DO NOTHING`, [roomId, run.id, line.agentId]);
        await delay(STARTER_BANTER_TYPING_MS);
        await this.database.transaction(async db => {
          const active = await db.query(`SELECT 1 FROM starter_onboarding_runs WHERE id=$1 AND status='playing' FOR UPDATE`, [run.id]);
          if (!active.rowCount) return;
          await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,clock_timestamp())`,
            [randomBytes(32).toString('hex'), roomId, line.agentId, line.text]);
          await db.query(`DELETE FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`, [roomId, run.id, line.agentId]);
        });
      }
    } finally {
      await this.database.transaction(async db => {
        const active = await db.query(`SELECT 1 FROM starter_onboarding_runs WHERE id=$1 AND status='playing' FOR UPDATE`, [run.id]);
        await db.query(`DELETE FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [roomId, run.id]);
        if (!active.rowCount) return;
        choice = await postStarterWelcome(db, { roomId, agentId: run.beebee_id, userId, runId: run.id, ...(run.manual ? { manualUserId: userId } : {}) });
        if (lines) await recordOnboardingEvent(db, userId, 'banter_shown', { roomId });
        await db.query(`UPDATE starter_onboarding_runs SET status='complete' WHERE id=$1`, [run.id]);
      });
    }
    return choice;
  }
}
