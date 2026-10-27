import {
  FUNNEL_FIRST_SESSION_MS,
  FUNNEL_SCREEN_SEND_CAP,
  FUNNEL_UUID,
  parseSigninFunnelEvent,
  type SigninFunnelEvent,
  type FunnelAuthObservation,
  ONBOARDING_EVENTS,
  type OnboardingEvent,
} from '@beeline/api-contract/signin-funnel';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { COHORT_SQL } from './operator-dashboard-cohort.js';
import { typedMentionHandles } from './message-mentions.js';

const lastCompaction = new WeakMap<SqlDatabase, string>();

// Only these confirmed operator accounts are excluded; customer Workspace owners are not internal.
const TEAM_HANDLES = ['lunchboxfortwo', 'bananaman614305', 'moonscannerai'];
function funnelAccountHash(identityId: string) {
  return createHash('sha256').update(`beeline-onboarding:${identityId}`).digest('hex');
}

export async function recordOnboardingEvent(database: SqlDatabase, identityId: string, event: OnboardingEvent,
  detail: { option?: 'A' | 'B' | 'C' | 'D'; durationMs?: number; artifactId?: string } = {}) {
  const context = (await database.query<{ install_id: string; attempt_id: string; platform: SigninFunnelEvent['platform']; version: string }>(
    `SELECT e.install_id,e.attempt_id,e.platform,e.version FROM signin_funnel_installs i
     JOIN signin_funnel_events e ON e.install_id=i.install_id
     WHERE i.account_hash=$1 AND NOT i.internal AND e.event='signed_in'
       AND ($2 <> 'user_answered' OR EXISTS(SELECT 1 FROM signin_funnel_events pick
         WHERE pick.install_id=e.install_id AND pick.attempt_id=e.attempt_id AND pick.event='option_picked'))
       AND EXISTS(SELECT 1 FROM signin_funnel_events signup WHERE signup.install_id=e.install_id
         AND signup.attempt_id=e.attempt_id AND signup.event='signup')
     ORDER BY EXISTS(SELECT 1 FROM signin_funnel_events welcome WHERE welcome.install_id=e.install_id
       AND welcome.attempt_id=e.attempt_id AND welcome.event='welcome_shown') DESC,e.occurred_at DESC LIMIT 1`, [funnelAccountHash(identityId), event],
  )).rows[0];
  if (!context) return;
  await recordSigninFunnelEvent(database, {
    event, installId: context.install_id, attemptId: context.attempt_id,
    platform: context.platform, version: context.version, environment: 'production',
    timestamp: new Date().toISOString(), ...detail,
  }, 'server', identityId);
}

export async function observeOnboardingMessage(database: SqlDatabase, roomId: string, identityId: string, depth?: number, text = '') {
  const team = (await database.query<{ owner_id: string; agent_id: string; handle: string | null }>(
    `SELECT f.owner_id,f.agent_id,i.handle FROM free_agents f JOIN identities i ON i.id=f.agent_id
     JOIN memberships m ON m.identity_id=f.agent_id AND m.room_id=$1 AND m.removed_at IS NULL
     WHERE f.starter_role IS NOT NULL AND f.removed_at IS NULL
       AND (f.owner_id=$2 OR EXISTS(SELECT 1 FROM free_agents self WHERE self.agent_id=$2 AND self.owner_id=f.owner_id))`,
    [roomId, identityId],
  )).rows;
  const owner = team[0]?.owner_id;
  if (owner && identityId === owner) {
    await recordOnboardingEvent(database, owner, 'user_answered');
    await recordOnboardingEvent(database, owner, 'task_question');
    const welcome = (await database.query<{ age: string }>(
      `SELECT EXTRACT(epoch FROM now()-min(e.occurred_at)) age FROM signin_funnel_events e
       JOIN signin_funnel_installs i ON i.install_id=e.install_id WHERE i.account_hash=$1 AND e.event='welcome_shown'`,
      [funnelAccountHash(owner)],
    )).rows[0];
    if (Number(welcome?.age) >= 86_400) await recordOnboardingEvent(database, owner, 'returned_day_1');
    if (Number(welcome?.age) >= 7 * 86_400) await recordOnboardingEvent(database, owner, 'returned_day_7');
  } else if (owner && depth !== undefined) {
    const peerHandles = [...typedMentionHandles(text)].map(handle => handle.toLowerCase());
    const mentionsPeer = peerHandles.length > 0 && (await database.query(
      `SELECT 1 FROM identities i JOIN memberships m ON m.identity_id=i.id AND m.room_id=$1
       AND m.removed_at IS NULL WHERE i.kind='agent' AND i.id<>$2 AND i.handle IS NOT NULL
       AND lower(btrim(i.handle,'@'))=ANY($3::text[]) LIMIT 1`, [roomId, identityId, peerHandles],
    )).rowCount > 0;
    if (depth === 0) {
      await recordOnboardingEvent(database, owner, 'task_first_answer');
      if (mentionsPeer)
        await recordOnboardingEvent(database, owner, 'task_review_requested');
    }
    if (!mentionsPeer && (depth === 0 || depth >= 2)) await recordOnboardingEvent(database, owner, 'task_final_answer');
  }
  const inviter = (await database.query<{ created_by: string }>(
    `SELECT created_by FROM invites WHERE onboarding_room_id=$1 AND onboarding_friend_id=$2 LIMIT 1`, [roomId, identityId],
  )).rows[0];
  if (inviter) await recordOnboardingEvent(database, inviter.created_by, 'invite_friend_messaged');
}

export async function observeOnboardingInvite(database: SqlDatabase, tokenHash: string, viewerId?: string, joined = false) {
  const invite = (await database.query<{ created_by: string; onboarding_created_at: string | Date }>(
    `SELECT created_by,onboarding_created_at FROM invites WHERE token_hash=$1 AND onboarding_room_id IS NOT NULL`, [tokenHash],
  )).rows[0];
  if (!invite || invite.created_by === viewerId) return;
  await recordOnboardingEvent(database, invite.created_by, 'invite_opened');
  if (joined && viewerId) {
    await database.query(`UPDATE invites SET onboarding_friend_id=$2 WHERE token_hash=$1`, [tokenHash, viewerId]);
    if ((await database.query(`SELECT 1 FROM signin_funnel_installs i JOIN signin_funnel_events e ON e.install_id=i.install_id
      JOIN identities person ON person.id=$3 WHERE i.account_hash=$1 AND e.event='signup'
        AND person.created_at >= $2::timestamptz`, [funnelAccountHash(viewerId), invite.onboarding_created_at, viewerId])).rowCount)
      await recordOnboardingEvent(database, invite.created_by, 'invite_friend_signed_up');
  }
}
export class FunnelRateLimit {
  private readonly clients = new Map<string, { start: number; count: number }>();
  allow(ip: string, now = Date.now()): boolean {
    const row = this.clients.get(ip);
    if (!row || now - row.start >= 60_000) {
      if (this.clients.size >= 10_000) {
        for (const [key, value] of this.clients)
          if (now - value.start >= 60_000) this.clients.delete(key);
        if (this.clients.size >= 10_000) return false;
      }
      this.clients.set(ip, { start: now, count: 1 });
      return true;
    }
    // Allows a first session's FUNNEL_SCREEN_SEND_CAP screen events plus its funnel steps.
    return ++row.count <= 128;
  }
}
export async function recordSigninFunnelEvent(
  database: SqlDatabase,
  event: SigninFunnelEvent,
  source: 'client' | 'server' = 'client',
  identityId?: string,
) {
  if (
    event.environment !== 'production' ||
    /(?:^|[.-])(dev|development|preview|lab)(?:[.-]|$)/i.test(event.version)
  )
    return;
  const today = new Date().toISOString().slice(0, 10);
  if (lastCompaction.get(database) !== today) {
    lastCompaction.set(database, today);
    try {
      await compactSigninFunnel(database);
    } catch (error) {
      lastCompaction.delete(database);
      throw error;
    }
  }
  if (source === 'client' && (['signed_in', 'workspace_created', 'first_message_sent', 'screen_shown'].includes(event.event) || ONBOARDING_EVENTS.includes(event.event as never)) && !identityId) return;
  if (source === 'client' && ONBOARDING_EVENTS.includes(event.event as never) && !['welcome_shown', 'game_viewer_opened', 'game_viewer_closed'].includes(event.event)) return;
  if (source === 'client' && ONBOARDING_EVENTS.includes(event.event as never) && !(await database.query(
    `SELECT 1 FROM signin_funnel_installs WHERE install_id=$1 AND account_hash=$2`,
    [event.installId, funnelAccountHash(identityId!)],
  )).rowCount) return;
  if (source === 'client' && ['game_viewer_opened', 'game_viewer_closed'].includes(event.event)) {
    if (!event.artifactId || !FUNNEL_UUID.test(event.artifactId)) return;
    const prerequisite = 'game_posted';
    if (!(await database.query(`SELECT 1 FROM signin_funnel_events WHERE install_id=$1 AND attempt_id=$2 AND event=$3 AND artifact_id=$4::uuid`,
      [event.installId, event.attemptId, prerequisite, event.artifactId])).rowCount) return;
  }
  if (event.event === 'screen_shown') {
    // Keep screens only for a new-account signup on this attempt, within its first session,
    // and stop at the send cap.
    const firstSession = (
      await database.query<{ visits: string }>(
        `SELECT (SELECT COALESCE(sum(visits),0) FROM signin_funnel_events
          WHERE install_id=$1 AND attempt_id=$2 AND event='screen_shown') AS visits
        FROM signin_funnel_events WHERE install_id=$1 AND attempt_id=$2 AND event='signup'
        AND occurred_at > now()-$3::int*interval '1 millisecond'`,
        [event.installId, event.attemptId, FUNNEL_FIRST_SESSION_MS],
      )
    ).rows[0];
    if (!firstSession || !event.screen || Number(firstSession.visits) >= FUNNEL_SCREEN_SEND_CAP) return;
  }
  let internal = false;
  if (identityId) {
    const row = (
      await database.query<{ internal: boolean }>(
        `WITH ${COHORT_SQL}
      SELECT (i.hidden_from_roster OR COALESCE(lower(i.handle)=ANY($2::text[]),false) OR NOT EXISTS(SELECT 1 FROM production_identities pi WHERE pi.id=i.id)) internal
      FROM identities i WHERE i.id=$1`,
        [identityId, TEAM_HANDLES],
      )
    ).rows[0];
    internal = row?.internal ?? true;
  }
  await database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO signin_funnel_installs(install_id,internal) VALUES($1,$2)
      ON CONFLICT(install_id) DO UPDATE SET internal=signin_funnel_installs.internal OR EXCLUDED.internal,seen_at=now()`,
      [event.installId, internal],
    );
    if (identityId && event.event === 'signed_in') await tx.query(
      `UPDATE signin_funnel_installs SET account_hash=$2 WHERE install_id=$1`, [event.installId, funnelAccountHash(identityId)],
    );
    await tx.query(
      `INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,provider,outcome,error_code,source,screen,last_seen_at,occurred_at,onboarding_option,duration_ms,artifact_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $3='welcome_shown' THEN $14::timestamptz ELSE now() END,$12,$13,$15::uuid) ON CONFLICT(install_id,attempt_id,event,provider,screen)
      DO UPDATE SET outcome=EXCLUDED.outcome,error_code=EXCLUDED.error_code,source=EXCLUDED.source,
        last_seen_at=GREATEST(signin_funnel_events.last_seen_at,EXCLUDED.last_seen_at),
        visits=signin_funnel_events.visits+CASE WHEN EXCLUDED.event='screen_shown' THEN 1 ELSE 0 END
      WHERE (EXCLUDED.source='server' AND signin_funnel_events.source='client') OR EXCLUDED.event='screen_shown'`,
      [
        event.installId,
        event.attemptId,
        event.event,
        event.platform,
        event.version,
        event.provider ?? '',
        event.outcome ?? '',
        event.errorCode ?? null,
        source,
        event.screen ?? '',
        // Screen order comes from the device's time, not arrival order.
        event.event === 'screen_shown' ? event.timestamp : null,
        event.option ?? null,
        event.durationMs ?? null,
        event.timestamp,
        event.artifactId ?? null,
      ],
    );
    if (event.event === 'signed_in' && identityId && !internal) {
      // Classify at authentication, then retain only the anonymous completion.
      // An existing account on another install is a sign-in, not another signup.
      await tx.query(
        `INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,provider,outcome,source,occurred_at)
        SELECT e.install_id,e.attempt_id,'signup',e.platform,e.version,e.provider,'','server',e.occurred_at
        FROM signin_funnel_events e JOIN identities i ON i.id=$3
        WHERE e.install_id=$1 AND e.attempt_id=$2 AND e.event='signed_in' AND e.provider=$4
          AND i.kind='human' AND i.created_at<=e.occurred_at
          AND EXISTS(SELECT 1 FROM signin_funnel_events start
            WHERE start.install_id=e.install_id AND start.attempt_id=e.attempt_id
              AND start.event='provider_tapped' AND start.provider=e.provider
              AND start.occurred_at<=i.created_at)
        ON CONFLICT DO NOTHING`,
        [event.installId, event.attemptId, identityId, event.provider ?? ''],
      );
    }
  });
}
export async function observeFunnelAuth(database: SqlDatabase, input: FunnelAuthObservation) {
  if (input.phase === 'start') {
    const event = parseSigninFunnelEvent(input.context);
    if (
      !event ||
      event.event !== 'provider_tapped' ||
      event.environment !== 'production' ||
      event.provider !== input.provider
    )
      return;
    await database.query(
      `INSERT INTO signin_funnel_auth_flows(flow_hash,context,expires_at) VALUES($1,$2::jsonb,now()+interval '30 minutes') ON CONFLICT DO NOTHING`,
      [input.flowHash, JSON.stringify(event)],
    );
    await recordSigninFunnelEvent(database, event, 'server');
  } else {
    const row = (
      await database.query<{ context: SigninFunnelEvent }>(
        `DELETE FROM signin_funnel_auth_flows WHERE flow_hash=$1 AND expires_at>now() RETURNING context`,
        [input.flowHash],
      )
    ).rows[0];
    if (!row || row.context.provider !== input.provider || !input.outcome) return;
    await recordSigninFunnelEvent(
      database,
      {
        ...row.context,
        event: 'callback_result',
        outcome: input.outcome,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        timestamp: new Date().toISOString(),
      },
      'server',
    );
  }
}
/** Sign-in detail compacts after 90 days; onboarding milestones retain the all-time cohort. */
export async function compactSigninFunnel(database: SqlDatabase) {
  await database.transaction(async (tx) => {
    await tx.query(`WITH expired AS (
      DELETE FROM signin_funnel_events e WHERE occurred_at < (now() AT TIME ZONE 'UTC')::date-89
        AND NOT e.event=ANY($1::text[])
        AND NOT (e.event IN ('signup','signed_in') AND EXISTS(
          SELECT 1 FROM signin_funnel_events welcome WHERE welcome.install_id=e.install_id AND welcome.event='welcome_shown'))
      RETURNING *
    ), counts AS (
      SELECT (e.occurred_at AT TIME ZONE 'UTC')::date AS day,e.platform,e.event,e.provider,e.outcome,count(DISTINCT e.install_id) installs
      FROM expired e JOIN signin_funnel_installs i ON i.install_id=e.install_id WHERE NOT i.internal GROUP BY 1,2,3,4,5
    ) INSERT INTO signin_funnel_daily SELECT * FROM counts ON CONFLICT(day,platform,event,provider,outcome)
      DO UPDATE SET installs=signin_funnel_daily.installs+EXCLUDED.installs`, [[...ONBOARDING_EVENTS]]);
    await tx.query(`DELETE FROM signin_funnel_auth_flows WHERE expires_at<=now()`);
    await tx.query(`DELETE FROM signin_funnel_installs WHERE seen_at < now()-interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM signin_funnel_events e WHERE e.install_id=signin_funnel_installs.install_id)`);
  });
}
export async function dashboardSigninFunnel(
  database: SqlDatabase,
  platforms: readonly string[],
  measuredAt: string,
  from: string,
  through: string,
  downloads: number | null,
  downloadCounts: Record<string, number | null> = {},
) {
  await compactSigninFunnel(database);
  const coverageStart =
    (
      await database.query<{ day: string | null }>(
        `SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date::text AS day FROM signin_funnel_events`,
      )
    ).rows[0]?.day ?? null;
  const requestedFrom = from;
  if (coverageStart && coverageStart <= through && coverageStart > from) {
    from = coverageStart;
    const expectedDays = Math.round((Date.parse(through) - Date.parse(from)) / 86400000) + 1;
    const stores = (
      await database.query<{ platform: string; days: string; installs: string | null }>(
        `SELECT platform,count(installs) days,sum(installs) installs FROM store_download_days
      WHERE platform=ANY($1::text[]) AND day BETWEEN $2::date AND $3::date GROUP BY platform`,
        [[...platforms], from, through],
      )
    ).rows;
    downloadCounts = Object.fromEntries(
      platforms.map((platform) => {
        const row = stores.find((r) => r.platform === platform);
        return [platform, row && Number(row.days) === expectedDays ? Number(row.installs) : null];
      }),
    );
    const mobile = platforms.filter((p) => p === 'ios' || p === 'android');
    downloads =
      mobile.length && mobile.every((p) => downloadCounts[p] !== null)
        ? mobile.reduce((sum, p) => sum + downloadCounts[p]!, 0)
        : null;
  }
  const rows = (
    await database.query<{
      platform: string;
      event: string;
      provider: string;
      outcome: string;
      installs: string;
      date: string;
      period: string;
    }>(
      `WITH eligible AS (
    SELECT e.* FROM signin_funnel_events e JOIN signin_funnel_installs i ON i.install_id=e.install_id
    WHERE NOT i.internal AND e.event<>'screen_shown' AND e.platform=ANY($1::text[]) AND e.occurred_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND e.occurred_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')
  ), periods AS (
    SELECT *, 'window' period, '' date FROM eligible UNION ALL
    SELECT *, 'daily', (occurred_at AT TIME ZONE 'UTC')::date::text FROM eligible UNION ALL
    SELECT *, 'weekly', ($3::date - (((($3::date-(occurred_at AT TIME ZONE 'UTC')::date)/7)::int)*7))::text FROM eligible
  ) SELECT COALESCE(platform,'all') platform,event,COALESCE(provider,'all') provider,COALESCE(outcome,'all') outcome,period,date,count(DISTINCT install_id) installs
    FROM periods GROUP BY GROUPING SETS ((platform,event,provider,outcome,period,date),(event,provider,outcome,period,date),(platform,event,period,date),(event,period,date))`,
      [[...platforms], from, through],
    )
  ).rows;
  const stages = [
    'app_opened',
    'signin_screen_shown',
    'provider_tapped',
    'callback_result',
    'signed_in',
    'signup',
    'workspace_created',
    'first_message_sent',
  ] as const;
  const slices = ['all', ...platforms];
  const totals = rows.filter(
    (r) => r.period === 'window' && r.provider === 'all' && r.outcome === 'all',
  );
  const byPlatform = slices.map((platform) => {
    const result = stages.map((stage) => ({
      stage,
      count: 0,
      denominator: null as number | null,
      dropOffCount: null as number | null,
      dropOffRate: null as number | null,
    }));
    let previous =
      platform === 'all'
        ? platforms.every((p) => p === 'ios' || p === 'android')
          ? downloads
          : null
        : (downloadCounts[platform] ?? null);
    for (const stage of result) {
      stage.count = Number(
        totals.find((r) => r.platform === platform && r.event === stage.stage)?.installs ?? 0,
      );
      stage.denominator = previous;
      stage.dropOffCount = previous === null ? null : previous - stage.count;
      stage.dropOffRate = previous ? (previous - stage.count) / previous : null;
      previous = stage.count;
    }
    const providers = ['github', 'google'].map((provider) => {
      const started = rows.find(
        (r) =>
          r.platform === platform &&
          r.provider === provider &&
          r.event === 'provider_tapped' &&
          r.period === 'window',
      );
      const completed = rows.find(
        (r) =>
          r.platform === platform &&
          r.provider === provider &&
          r.event === 'signed_in' &&
          r.period === 'window',
      );
      const starts = Number(started?.installs ?? 0),
        completions = Number(completed?.installs ?? 0);
      return {
        provider,
        starts,
        completions,
        completionRate: starts ? completions / starts : null,
        outcomes: ['success', 'cancelled', 'error'].map((outcome) => ({
          outcome,
          count: Number(
            rows.find(
              (r) =>
                r.platform === platform &&
                r.provider === provider &&
                r.event === 'callback_result' &&
                r.outcome === outcome &&
                r.period === 'window',
            )?.installs ?? 0,
          ),
        })),
        series: rows
          .filter(
            (r) => r.platform === platform && r.provider === provider && r.period !== 'window',
          )
          .map((r) => ({
            period: r.period,
            date: r.date,
            stage: r.event,
            outcome: r.outcome,
            count: Number(r.installs),
          })),
      };
    });
    return {
      platform,
      stages: result,
      providers,
      series: rows
        .filter(
          (r) =>
            r.platform === platform &&
            r.provider === 'all' &&
            r.outcome === 'all' &&
            r.period !== 'window',
        )
        .map((r) => ({
          period: r.period,
          date: r.date,
          stage: r.event,
          count: Number(r.installs),
        })),
    };
  });
  const signupCounts = new Map<string, number>();
  for (const selection of ['all', ...platforms]) {
    const selected = selection === 'all' ? [...platforms] : [selection];
    const row = (
      await database.query<{ count: string }>(
        `WITH ${COHORT_SQL} SELECT count(*) count
      FROM identities i JOIN production_identities pi ON pi.id=i.id WHERE i.kind='human'
      AND i.created_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND i.created_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')
      AND ($4::boolean OR EXISTS(SELECT 1 FROM push_devices d WHERE d.identity_id=i.id AND d.platform=ANY($1::text[]))
        OR EXISTS(SELECT 1 FROM device_update_receipts d WHERE d.identity_id=i.id AND d.receipt->>'platform'=ANY($1::text[])))`,
        [selected, from, through, selected.length === 6],
      )
    ).rows[0];
    signupCounts.set(selection, Number(row?.count ?? 0));
  }
  const firstSession = await dashboardFirstSessionScreens(database, platforms, measuredAt);
  return {
    state: coverageStart && through >= coverageStart ? 'measured' : 'not_measured',
    measuredAt,
    from,
    requestedFrom,
    through,
    downloads: {
      stage: 'downloads',
      count: coverageStart && through >= coverageStart ? downloads : null,
      perPlatform: downloadCounts,
    },
    unit: 'installs',
    source:
      'Client action events; validated server OAuth starts and callbacks override client reports; authenticated signed-in events exclude internal installs and classify new-account Signup completions.',
    note: 'Stages count distinct installs within the window, not a joined person cohort. Signup counts installs whose account was created during that same provider attempt; returning-account sign-ins do not count as Signup. Retries and different providers can overlap. Collection begins with this release; earlier dates are unmeasured.',
    coverageStart,
    perPlatform: byPlatform.map((p) => ({
      ...p,
      signup: {
        stage: 'signup',
        unit: 'people',
        count:
          coverageStart && through >= coverageStart ? (signupCounts.get(p.platform) ?? null) : null,
        source: 'Existing production human identity creation, over this same window',
      },
      stages: p.stages.map((s) => ({
        ...s,
        count: coverageStart && through >= coverageStart ? s.count : null,
        denominator: coverageStart && through >= coverageStart ? s.denominator : null,
        dropOffCount: coverageStart && through >= coverageStart ? s.dropOffCount : null,
        dropOffRate: coverageStart && through >= coverageStart ? s.dropOffRate : null,
      })),
    })),
    firstSession,
    dailyAggregatesRetainedAfterDays: 90,
  };
}

// Read the existing event ledger once per period; account hashes deduplicate reinstalls.
export async function dashboardOnboarding(database: SqlDatabase, from: string | null, measuredAt: string) {
  const rows = (await database.query<{
    account_hash: string; event: OnboardingEvent; occurred_at: string | Date;
    onboarding_option: 'A' | 'B' | 'C' | 'D' | null; duration_ms: number | string | null;
  }>(`SELECT i.account_hash,e.event,e.occurred_at,e.onboarding_option,e.duration_ms
      FROM signin_funnel_events e JOIN signin_funnel_installs i ON i.install_id=e.install_id
      WHERE NOT i.internal AND i.account_hash IS NOT NULL AND e.event=ANY($1::text[])
        AND e.occurred_at<$2::timestamptz ORDER BY e.occurred_at`,
    [[...ONBOARDING_EVENTS], measuredAt],
  )).rows;
  const people = new Map<string, typeof rows>();
  for (const row of rows) {
    const entries = people.get(row.account_hash) ?? [];
    entries.push(row);
    people.set(row.account_hash, entries);
  }
  const at = (row: typeof rows[number]) => new Date(row.occurred_at).getTime();
  const end = Date.parse(measuredAt);
  const cohort = [...people.values()].filter(events => {
    const welcome = events.find(event => event.event === 'welcome_shown');
    return welcome && (from === null || at(welcome) >= Date.parse(from));
  });
  const main = ['welcome_shown', 'option_picked', 'answered_after_pick', 'return_1d', 'return_7d'] as const;
  const source: Record<string, OnboardingEvent> = {
    welcome_shown: 'welcome_shown', option_picked: 'option_picked', answered_after_pick: 'user_answered',
    return_1d: 'returned_day_1', return_7d: 'returned_day_7',
    task_first_answer: 'task_first_answer', task_second_opinion: 'task_review_requested', task_final_answer: 'task_final_answer',
    game_posted: 'game_posted', game_viewer_opened: 'game_viewer_opened', game_closed: 'game_viewer_closed',
    invite_link_created: 'invite_created', invite_shared: 'invite_shared', invite_opened: 'invite_opened',
    invite_friend_signed_up: 'invite_friend_signed_up', invite_friend_messaged: 'invite_friend_messaged',
  };
  const milestone = (events: typeof rows, key: string) => {
    const pick = events.find(event => event.event === 'option_picked');
    const welcome = events.find(event => event.event === 'welcome_shown')!;
    return events.find(event => event.event === source[key] && at(event) >= at(welcome) &&
      (key !== 'answered_after_pick' || (pick && at(event) >= at(pick))) &&
      (key !== 'return_1d' || at(event) - at(welcome) >= 86_400_000) &&
      (key !== 'return_7d' || at(event) - at(welcome) >= 7 * 86_400_000));
  };
  const list = (selected: typeof cohort, keys: readonly string[], firstPrevious?: string) => keys.map((key, index) => {
    const previous = index ? keys[index - 1] : firstPrevious;
    let count = 0;
    const seconds: number[] = [];
    for (const events of selected) {
      const current = milestone(events, key);
      if (!current) continue;
      count++;
      const prior = previous ? milestone(events, previous) : undefined;
      if (prior && at(current) >= at(prior)) {
        const duration = key === 'game_closed' ? Number(current.duration_ms) : at(current) - at(prior);
        if ((key !== 'game_closed' || current.duration_ms !== null) && Number.isFinite(duration) && duration >= 0)
          seconds.push(duration / 1000);
      }
    }
    seconds.sort((a, b) => a - b);
    const middle = Math.floor(seconds.length / 2);
    return { key, count,
      eligible: key === 'return_1d' || key === 'return_7d'
        ? selected.filter(events => end - at(events.find(event => event.event === 'welcome_shown')!) >=
          (key === 'return_1d' ? 1 : 7) * 86_400_000).length : null,
      medianSecondsFromPrevious: seconds.length < 5 ? null : Math.round(seconds.length % 2 ? seconds[middle]!
        : (seconds[middle - 1]! + seconds[middle]!) / 2),
      samples: seconds.length };
  });
  const steps = list(cohort, main);
  let biggestDrop: string | null = null;
  let lost = 0;
  for (let i = 1; i < steps.length; i++) {
    const drop = steps[i - 1]!.count - steps[i]!.count;
    if (drop > 0 && drop >= lost) { biggestDrop = steps[i]!.key; lost = drop; }
  }
  return {
    cohort: 'welcome_shown_in_window' as const,
    steps,
    paths: {
      task: list(cohort, ['task_first_answer', 'task_second_opinion', 'task_final_answer'], 'option_picked'),
      game: list(cohort, ['game_posted', 'game_viewer_opened', 'game_closed']),
      invite: list(cohort, ['invite_link_created', 'invite_shared', 'invite_opened', 'invite_friend_signed_up', 'invite_friend_messaged']),
    },
    byOption: Object.fromEntries(([['task', 'A'], ['game', 'B'], ['invite', 'C'], ['special', 'D']] as const)
      .map(([name, option]) => [name, { steps: list(cohort.filter(events =>
        events.find(event => event.event === 'option_picked')?.onboarding_option === option), main) }])),
    biggestDrop,
  };
}
/**
 * Per Signup cohort day: how many new signups reached each screen in their
 * first 10 minutes, and on which screen each one's first session ended,
 * counting revisits.
 * Aggregated counts only. Builds without screen events count as zero.
 * Covers the last 14 UTC days through today; it does not wait for store reports.
 */
async function dashboardFirstSessionScreens(
  database: SqlDatabase,
  platforms: readonly string[],
  measuredAt: string,
) {
  const through = measuredAt.slice(0, 10);
  const from = new Date(Date.parse(through) - 13 * 86_400_000).toISOString().slice(0, 10);
  const params = [[...platforms], from, through, FUNNEL_FIRST_SESSION_MS, FUNNEL_SCREEN_SEND_CAP];
  const cohort = `cohort AS (
    SELECT s.install_id,s.attempt_id,s.occurred_at AS signed_at,(s.occurred_at AT TIME ZONE 'UTC')::date::text AS day
    FROM signin_funnel_events s JOIN signin_funnel_installs i ON i.install_id=s.install_id
    WHERE s.event='signup' AND NOT i.internal AND s.platform=ANY($1::text[])
      AND s.occurred_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND s.occurred_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')
  ), shown AS (
    SELECT c.day,c.install_id,c.attempt_id,e.screen,row_number() OVER (
      PARTITION BY c.install_id,c.attempt_id ORDER BY e.last_seen_at DESC,e.recorded_at DESC) AS recency,
      sum(e.visits) OVER (PARTITION BY c.install_id,c.attempt_id) >= $5::int AS capped
    FROM cohort c JOIN signin_funnel_events e ON e.install_id=c.install_id AND e.attempt_id=c.attempt_id
      AND e.event='screen_shown' AND e.occurred_at < c.signed_at+$4::int*interval '1 millisecond'
  )`;
  const days = (
    await database.query<{ day: string; signups: string; with_screens: string; capped: string }>(
      `WITH ${cohort} SELECT c.day,count(*) AS signups,count(*) FILTER (WHERE EXISTS(SELECT 1 FROM shown s
        WHERE s.install_id=c.install_id AND s.attempt_id=c.attempt_id)) AS with_screens,
        count(*) FILTER (WHERE EXISTS(SELECT 1 FROM shown s
        WHERE s.install_id=c.install_id AND s.attempt_id=c.attempt_id AND s.capped)) AS capped
      FROM cohort c GROUP BY c.day ORDER BY c.day`,
      params,
    )
  ).rows;
  const screens = (
    await database.query<{ day: string; screen: string; reached: string; last: string }>(
      `WITH ${cohort} SELECT day,screen,count(*) AS reached,count(*) FILTER (WHERE recency=1 AND NOT capped) AS last
      FROM shown GROUP BY day,screen ORDER BY day,count(*) DESC,screen`,
      params,
    )
  ).rows;
  return {
    from,
    through,
    unit: 'people',
    windowMinutes: FUNNEL_FIRST_SESSION_MS / 60_000,
    source:
      'Authenticated screen_shown route patterns from new-account Signup attempts, kept only within 10 minutes of sign-in.',
    days: days.map((d) => ({
      date: d.day,
      signups: Number(d.signups),
      withScreens: Number(d.with_screens),
      // People who hit the send cap: their screens count as reached, but they get no last screen.
      capped: Number(d.capped),
      screens: screens
        .filter((s) => s.day === d.day)
        .map((s) => ({ screen: s.screen, reached: Number(s.reached), last: Number(s.last) })),
    })),
  };
}
