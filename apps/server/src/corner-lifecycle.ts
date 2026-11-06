import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { deleteCornerWakeSources } from './corner-wake-cleanup.js';
import { releaseArchivedCornerHolds } from './corner-holds.js';
import { workingTurnFreshSql } from './turn-ownership.js';
import { cornerLifecycleSql } from './corner-github-cache.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { REVIEW_VERDICT_SQL, missingReviewAttachments } from './review-evidence.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { cornerReportWaiting } from './corner-state.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { isZeroCheckCommander } from './corner-merge-approval.js';
import { reportToCommander } from './commander.js';
import type { activeCornerHolds } from './corner-holds.js';
import { createHash } from 'node:crypto';
import type {
  CornerLifecycleView,
  CornerStateFacts,
  DerivedCornerState,
} from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import {
  insertAgentCommand as createAgentCommand,
  refuseVerdictedReviewerWake,
  currentCornerCommandTargetSql,
  repairReviewerCornerMembership,
  type CommandRow,
} from './agent-command.js';
import { assertCornerBriefAllowsMerge } from './corner-brief.js';
import { cornerImplementerSql } from './corner-worker.js';
import { firstHealthyAgent } from './agent-health.js';
import { ensureSystemIdentity, GITHUB_SUBJECT, systemLine } from './system-line.js';
import { abandonCornerWorkflowRuns, workflowRunLockKey } from './workflow-runs.js';

import { cornerIdleSql, type CornerIdleRow } from './corner-idle.js';

export const CORNER_LIFECYCLE_SLUG = 'corner';

export type CornerEvent =
  | {
      kind: 'open';
      command?: Parameters<typeof createAgentCommand>[1];
    }
  | { kind: 'push'; headSha: string; contents: Record<string, unknown> }
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId: string; followup?: boolean }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  /** A yes on this head: a reviewer's PASS or a person's order, landed by the caller. */
  | { kind: 'approval'; headSha: string; by: 'reviewer' | 'person' }
  | { kind: 'merge-refused'; headSha: string; reason: string; confirmedUnmerged?: boolean }
  | { kind: 'merged'; contents: Record<string, unknown> }
  | { kind: 'pull-request-closed'; number: number }
  | { kind: 'closed' }
  | { kind: 'merge-conflict'; sourceMessageId: string }
  | { kind: 'check-observation'; observation: CornerCheckObservation }
  | { kind: 'reconcile' }
  | { kind: 'command'; command: Parameters<typeof createAgentCommand>[1] };

type CornerRow = {
  machine: CornerMachine | null;
  parent_id: string;
  worker_agent_id: string | null;
  lifecycle: CornerLifecycleView;
  archived: boolean;
  locked: boolean;
  configured_reviewer_id: string | null;
  configured_reviewer_kind: string | null;
  configured_reviewer_name: string | null;
  reviewer_parent_member: boolean;
};

export async function lockCornerLifecycle(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workflowRunLockKey(cornerId)]);
}

export const CORNER_GITHUB_CACHE_MIRROR_SQL = `
INSERT INTO corner_github_cache(corner_id,lifecycle)
  SELECT corner_id,lifecycle FROM corner_facts ON CONFLICT(corner_id) DO NOTHING;
CREATE OR REPLACE FUNCTION corner_facts_lifecycle_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  INSERT INTO corner_github_cache(corner_id,lifecycle) VALUES(NEW.corner_id,NEW.lifecycle)
  ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle
    WHERE corner_github_cache.lifecycle IS DISTINCT FROM EXCLUDED.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_facts_lifecycle_mirror ON corner_facts;
CREATE TRIGGER corner_facts_lifecycle_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_facts_lifecycle_mirror();
CREATE OR REPLACE FUNCTION corner_github_cache_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  UPDATE corner_facts SET lifecycle=NEW.lifecycle
    WHERE corner_id=NEW.corner_id AND lifecycle IS DISTINCT FROM NEW.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_github_cache_mirror ON corner_github_cache;
CREATE TRIGGER corner_github_cache_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_github_cache
  FOR EACH ROW EXECUTE FUNCTION corner_github_cache_mirror();
`;

/**
 * The corner's own row: created once with the corner, then changed only by
 * this module (its lock and its reviewer). Its GitHub display cache row starts
 * with it and is then written only from GitHub (`corner_github_cache`).
 */
export async function createCornerFacts(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(
    `INSERT INTO corner_facts(corner_id,lifecycle)
     VALUES($1,'{"lifecycle":"working","checks":"unknown"}') ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
  await db.query(
    `INSERT INTO corner_github_cache(corner_id) VALUES($1) ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
}

/** A person's lock: merges then keep the corner open (`corner lock`). */
export async function setCornerLockedFact(
  db: SqlDatabase,
  cornerId: string,
  locked: boolean,
): Promise<void> {
  await db.query(`UPDATE corner_facts SET locked=$2 WHERE corner_id=$1`, [cornerId, locked]);
}

/** Account deletion: corners whose own reviewer was a deleted agent fall back to their Room's. */
export async function clearCornerReviewers(db: SqlDatabase, agentIds: string[]): Promise<void> {
  await db.query(`UPDATE corner_facts SET reviewer_agent_id=NULL WHERE reviewer_agent_id=ANY($1)`, [
    agentIds,
  ]);
}

/** The corner's own reviewer; returns whether it changed. Callers check authority first. */
export async function setCornerReviewerFact(
  db: SqlDatabase,
  cornerId: string,
  reviewerId: string,
): Promise<boolean> {
  return (
    ((
      await db.query(
        `UPDATE corner_facts SET reviewer_agent_id=$2
     WHERE corner_id=$1 AND reviewer_agent_id IS DISTINCT FROM $2 RETURNING corner_id`,
        [cornerId, reviewerId],
      )
    ).rowCount ?? 0) > 0
  );
}

async function loadCorner(db: SqlDatabase, cornerId: string): Promise<CornerRow | undefined> {
  db = new CornerAccessDatabase(db);
  return (
    await db.query<CornerRow>(
      `SELECT fact.machine,corner.parent_id,
              ${cornerImplementerSql('fact', 'corner')} worker_agent_id,
              ${cornerLifecycleSql('fact.corner_id')},fact.locked,
              corner.archived_at IS NOT NULL archived,
              ${cornerReviewerSql()} configured_reviewer_id,
              configured.kind configured_reviewer_kind,
              configured.name configured_reviewer_name,
              EXISTS (
                SELECT 1 FROM memberships reviewer_membership
                JOIN identities reviewer ON reviewer.id=reviewer_membership.identity_id
                  AND reviewer.kind='agent'
                WHERE reviewer_membership.room_id=parent.id
                  AND reviewer_membership.identity_id=${cornerReviewerSql()}
                  AND reviewer_membership.removed_at IS NULL
              ) reviewer_parent_member
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN identities configured ON configured.id=${cornerReviewerSql()}
       WHERE fact.corner_id=$1
       FOR UPDATE OF fact`,
      [cornerId],
    )
  ).rows[0];
}

type CornerCheckSummary = NonNullable<CornerLifecycleView['checksSummary']> & {
  reportedHeadSha?: string;
  reportedFailing?: readonly string[];
  failureFollowupSent?: boolean;
  partialRepairSent?: boolean;
  attempt?: number;
  statusChangedAt?: number;
};
type CornerCheckObservation = {
  headSha: string;
  previousHeadSha?: string;
  prior?: CornerCheckSummary;
  next: CornerCheckSummary;
  workerBusy: boolean;
};
type CornerChecksPlan = {
  sameReportedHead: boolean;
  newAttempt: boolean;
  attempt: number;
  newFailures: string[];
  followup: boolean;
  partialRepair: boolean;
  reportFailure: boolean;
  storedSummary: CornerCheckSummary;
};

/** The only corner state machine. Provider facts and execution receipts are inputs;
 * every transition, wake and notification is decided here, including recovery. */
export type CornerMachine = {
  headSha?: string;
  pullRequest?: number;
  effects?: string[];
  outcome?: 'landed' | 'closed';
} & (
  | { state: 'working' | 'idle' | 'archived' }
  | { state: 'review'; phase: 'checks' | 'reviewer' }
  | { state: 'waiting'; reason: 'blocked' | 'user_action' | 'question' }
);
type MachineWake = {
  kind:
    | 'open'
    | 'revision'
    | 'checks-failed'
    | 'review'
    | 'review-findings'
    | 'review-no-verdict'
    | 'review-gap'
    | 'land'
    | 'merge-refused'
    | 'merge-conflict'
    | 'command';
  key: string;
};
type MachineNotification = { kind: 'idle' | 'waiting' | 'draft'; key: string };
export type CornerMachineFacts = CornerStateFacts & {
  headSha?: string;
  approved?: boolean;
  mergeHeld?: boolean;
  mergeConflictDelivered?: boolean;
  draftReadyFailure?: boolean;
  waitReason?: 'blocked' | 'user_action' | 'question';
  reviewerConfigured?: boolean;
  reviewEnded?: { id: string; findings?: string };
  idleSince?: string;
  idleEligible?: boolean;
  checkSourceId?: string;
  checkFollowup?: boolean;
  checkAttempt?: number;
};
export type CornerMachineEvent = { facts: CornerMachineFacts; event: CornerEvent };
export function transitionCorner(
  current: CornerMachine,
  { facts: f, event }: CornerMachineEvent,
): {
  state: CornerMachine;
  wakes: MachineWake[];
  notifications: MachineNotification[];
  suppression?: string;
  checksPlan?: CornerChecksPlan;
} {
  if (event.kind === 'check-observation') {
    const { headSha, previousHeadSha, prior, next, workerBusy } = event.observation;
    const sameReportedHead = prior?.reportedHeadSha === headSha;
    const newAttempt = sameReportedHead && checksRestarted(prior.checks, next.checks);
    const attempt = sameReportedHead ? (prior.attempt ?? 0) + (newAttempt ? 1 : 0) : 0;
    const reported = sameReportedHead && !newAttempt ? (prior.reportedFailing ?? []) : [];
    const newFailures = next.failing.filter((name) => !reported.includes(name));
    const firstFailure = next.status === 'failing' && newFailures.length > 0 && !reported.length;
    const followup =
      next.status === 'failing' &&
      reported.length > 0 &&
      checksSettled(next.checks) &&
      !checksSettled(prior?.checks ?? []) &&
      !(sameReportedHead && !newAttempt && prior.failureFollowupSent);
    // A later failed job, after the first repair turn has ended, wakes
    // once without waiting for the checks that are still running.
    const partialRepair =
      !followup &&
      next.status === 'failing' &&
      !checksSettled(next.checks) &&
      reported.length > 0 &&
      newFailures.length > 0 &&
      !workerBusy &&
      !(sameReportedHead && !newAttempt && prior.partialRepairSent);
    const reportFailure = firstFailure || followup || partialRepair;
    const storedSummary = {
      ...next,
      // Repeated reads of an unchanged status do not start new idle work.
      statusChangedAt:
        previousHeadSha === headSha &&
        prior?.status === next.status &&
        !newAttempt &&
        JSON.stringify((prior.checks ?? []).map((check) => [check.name, check.status]).sort()) ===
          JSON.stringify(next.checks.map((check) => [check.name, check.status]).sort())
          ? ((prior as typeof prior & { statusChangedAt?: number })?.statusChangedAt ??
            prior.fetchStartedAt ??
            prior.updatedAt)
          : next.fetchStartedAt,
      attempt,
      reportedHeadSha: headSha,
      reportedFailing: reportFailure ? [...reported, ...newFailures] : reported,
      failureFollowupSent: Boolean(
        (sameReportedHead && !newAttempt && prior.failureFollowupSent) || followup,
      ),
      partialRepairSent: Boolean(
        (sameReportedHead && !newAttempt && prior.partialRepairSent) || partialRepair,
      ),
    };
    return {
      state: current,
      wakes: [],
      notifications: [],
      checksPlan: {
        sameReportedHead,
        newAttempt,
        attempt,
        newFailures,
        followup,
        partialRepair,
        reportFailure,
        storedSummary,
      },
    };
  }
  const headSha = f.headSha ?? f.lifecycle?.pr?.headSha ??
    (event.kind === 'push' ? event.headSha : event.kind !== 'pull-request-closed' &&
      f.lifecycle?.checksSummary?.status === 'unknown' && f.lifecycle.checksSummary.fetchStartedAt === undefined
      ? current.headSha : undefined);
  const pullRequest = f.lifecycle?.pr?.number;
  const effects = (current.headSha === headSha && current.pullRequest === pullRequest
    ? [...(current.effects ?? [])] : [])
    .filter(key => key !== `merge-conflict:${headSha ?? ''}` || f.mergeConflictDelivered !== false);
  const base = {
    ...(headSha ? { headSha } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    effects,
  };
  const wakes: MachineWake[] = [];
  const notifications: MachineNotification[] = [];
  const wake = (kind: MachineWake['kind'], key = `${kind}:${headSha ?? ''}`) => {
    if (!effects.includes(key)) wakes.push({ kind, key });
  };
  const notify = (kind: MachineNotification['kind'], key: string) => {
    if (!effects.includes(key)) notifications.push({ kind, key });
  };
  const checks = f.lifecycle?.checks ?? f.lifecycle?.checksSummary?.status;
  const checksUnderway =
    checks === 'pending' ||
    f.lifecycle?.checksSummary?.checks.some((check) => check.status === 'pending') ||
    (Boolean(f.lifecycle?.pr || headSha) &&
      f.lifecycle?.checksSummary?.status === 'unknown' &&
      f.lifecycle.checksSummary.total === 0 &&
      f.lifecycle.checksSummary.fetchStartedAt === undefined);
  const providerEnded = f.lifecycle?.outcome === 'abandoned' || f.lifecycle?.lifecycle === 'done';
  const merged = f.lifecycle?.outcome === 'landed' || Boolean(f.lifecycle?.pr?.mergedAt);
  if (
    event.kind === 'command' &&
    (current.state === 'archived' || f.archived) &&
    !['stop', 'restart'].includes(event.command.action ?? 'input')
  )
    return { state: current, wakes, notifications, suppression: 'archived' };
  if (event.kind === 'command') return { state: current, wakes: [{ kind: 'command', key: '' }], notifications };
  if (current.state === 'archived')
    return !f.archived && (event.kind === 'closed' || event.kind === 'merged')
      ? { state: event.kind === 'merged' ? { ...current, outcome: 'landed' } : current, wakes, notifications }
      : { state: current, wakes, notifications, suppression: 'archived' };
  if (
    f.archived ||
    event.kind === 'closed' ||
    (!f.locked && (providerEnded || merged || event.kind === 'merged'))
  )
    return {
      state: {
        ...base,
        state: 'archived',
        outcome:
          event.kind === 'merged' || merged || current.outcome === 'landed' ? 'landed' : 'closed',
      },
      wakes,
      notifications,
    };
  if (event.kind === 'checks-pending' && !checksUnderway) return { state: current, wakes, notifications, suppression: 'checks are not pending' };
  if (event.kind === 'checks' && (checks !== event.result || f.checkSourceId === 'stale'))
    return { state: current, wakes, notifications, suppression: 'stale check event' };
  if (
    (event.kind === 'approval' && event.headSha !== headSha) ||
    (event.kind === 'push' && event.headSha !== headSha) ||
    (event.kind === 'merge-refused' && event.headSha !== headSha)
  )
    return { state: current, wakes, notifications, suppression: 'stale head' };
  if (event.kind === 'approval' && checks === 'passing' && !effects.includes('approved-on-green')) effects.push('approved-on-green');
  if (f.approved && f.draftReadyFailure && checks === 'passing') notify('draft', `draft:${headSha}`);
  if (event.kind === 'open' && event.command)
    wake('open', `open:${event.command.privatePayload?.openKey ?? ''}`);
  if (event.kind === 'brief-revised') wake('revision', `revision:${event.revision}`);
  if (event.kind === 'merge-refused')
    wake(
      'merge-refused',
      `refused:${event.headSha}:${event.reason}:${event.confirmedUnmerged ? f.checkSourceId : ''}`,
    );
  // Explicit waits remain visible even while CI or a receipt is running. Red
  // and green facts still retain their existing admission through that wait.
  if (f.reviewEnded && headSha && !f.approved && !f.turnRunning && !f.blocker)
    wake(
      f.reviewEnded.findings ? 'review-findings' : 'review-no-verdict',
      `handback:${headSha}:${f.reviewEnded.id}`,
    );
  if (checks === 'failing' && f.checkSourceId && (!f.turnRunning || event.kind === 'checks'))
    wake(
      'checks-failed',
      `red:${headSha}:${f.checkAttempt ?? 0}:${f.checkFollowup || (event.kind === 'checks' && event.followup) ? f.checkSourceId : 'first'}`,
    );
  if (f.lifecycle?.pr?.mergeability === 'dirty') wake('merge-conflict');
  if (
    checks === 'passing' &&
    headSha &&
    f.lifecycle?.pr?.mergeability !== 'dirty'
  ) {
    if (f.approved) {
      if (!f.mergeHeld && !f.reviewerActive && event.kind !== 'approval' && !effects.includes('approved-on-green')) wake('land');
    } else if (!f.turnRunning && !f.reviewEnded && !f.reviewerActive) {
      if (f.reviewerConfigured) wake('review');
      else if (!f.blocker) wake('review-gap');
    }
  }
  let state: CornerMachine;
  if (
    f.blocker &&
    (f.blocker.blocker?.kind !== 'merge-hold' ||
      (!f.turnRunning &&
        !f.reviewerActive &&
        !checksUnderway &&
        !wakes.some((w) => w.kind === 'review')))
  ) {
    const reason =
      f.waitReason ??
      (f.blocker.reason === 'question'
        ? 'question'
        : f.blocker.reason === 'approve' || f.blocker.reason === 'connect'
          ? 'user_action'
          : 'blocked');
    state = { ...base, state: 'waiting', reason };
    notify('waiting', `waiting:${f.blocker.itemId ?? reason}`);
  } else if (f.turnRunning || wakes.some((w) => !['review', 'review-gap'].includes(w.kind)))
    state = { ...base, state: 'working' };
  else if (
    f.reviewerActive ||
    wakes.some((w) => w.kind === 'review') ||
    (checks === 'passing' &&
      Boolean(headSha) &&
      f.reviewerConfigured !== undefined &&
      !f.reviewEnded &&
      !f.approved)
  )
    state = { ...base, state: 'review', phase: 'reviewer' };
  else if (checksUnderway) state = { ...base, state: 'review', phase: 'checks' };
  else {
    state = { ...base, state: 'idle' };
    if (f.idleEligible && f.idleSince) notify('idle', `idle:${f.idleSince}`);
  }
  return { state, wakes, notifications };
}

/** Compatibility input adapter. All badge decisions use the machine above. */
export function deriveCornerState(facts: CornerStateFacts): DerivedCornerState {
  const { state } = transitionCorner({ state: 'idle' }, { facts, event: { kind: 'reconcile' } });
  return {
    state: state.state,
    ...(state.state === 'waiting' && facts.blocker ? facts.blocker : {}),
  };
}

/** Emit a provider observation into the same transition table before writing its fact. */
export function planCornerCheckObservation(observation: CornerCheckObservation): CornerChecksPlan {
  return transitionCorner(
    { state: 'idle' },
    {
      facts: { archived: false, turnRunning: false },
      event: { kind: 'check-observation', observation },
    },
  ).checksPlan!;
}

/** No check on the head is still running. */
export function checksSettled(checks: readonly { status: string }[] | undefined): boolean {
  return !checks?.some((check) => check.status === 'pending');
}

/** A new Actions job also identifies a rerun whose start webhook was missed. */
export function checksRestarted(
  previous: readonly { name: string; status: string; url?: string }[] | undefined,
  current: readonly { name: string; status: string; url?: string }[],
): boolean {
  if (!previous?.length || !checksSettled(previous)) return false;
  return (
    !checksSettled(current) ||
    current.some((check) => {
      const before = previous.find((item) => item.name === check.name);
      return Boolean(
        before?.url &&
        check.url &&
        actionsJobId(before.url) &&
        actionsJobId(check.url) &&
        actionsJobId(before.url) !== actionsJobId(check.url),
      );
    })
  );
}

export function actionsJobId(url: string | undefined): number | undefined {
  const match = url?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/);
  const id = match ? Number(match[1]) : undefined;
  return id && Number.isSafeInteger(id) ? id : undefined;
}

type RevisionWake = { queued: boolean; agentId?: string; reason?: string };
export type CornerAdvance = {
  archived?: boolean;
  state: string | undefined;
  accepted: boolean;
  wake?: RevisionWake;
  command?: CommandRow;
};
type Applied = { ok: true; wake?: RevisionWake };
const OK: Applied = { ok: true };

/** Expand only: old lifecycle cards remain inert for the previous image. */
export const CORNER_MACHINE_SCHEMA = `
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS machine jsonb;
`;

/** Startup/data migration admission uses committed facts only, never GitHub. */
export async function backfillCornerLifecycleRuns(db: SqlDatabase): Promise<number> {
  const rows = (
    await db.query<{ corner_id: string }>(
      'SELECT corner_id FROM corner_facts WHERE machine IS NULL',
    )
  ).rows;
  for (const row of rows) await advanceCorner(db, row.corner_id, { kind: 'reconcile' });
  return rows.length;
}

/** Archival writers take lifecycle first, then authority before command or
 * Room/member locks. Acquiring only at the archival trigger is too late. */
export async function lockCornerArchivalAuthority(database: SqlDatabase): Promise<void> {
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
}

/**
 * Cancels every pending or claimed input/resume/restart command for a corner, and any
 * turn still marked `working`, so a corner that just landed never leaves a
 * stale assignment behind. Shared by every path that archives a corner:
 * `closeCornerState` and the GitHub merge webhook.
 * Take command locks before the room's archival UPDATE/FOR UPDATE lock:
 * command output already holds its command when dispatch locks rooms FOR SHARE.
 */
async function cancelCornerAgentCommands(database: SqlDatabase, cornerId: string): Promise<void> {
  await lockCornerArchivalAuthority(database);
  const active = await database.query<CommandRow>(
    `SELECT * FROM agent_commands
     WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')
     ORDER BY created_at DESC,id DESC FOR UPDATE`,
    [cornerId],
  );
  // Only a claimed command has a helper turn to stop. A pending one never started;
  // cancelling it below is enough, and a stop for it would stay pending forever.
  const assignments = new Map<string, CommandRow>();
  for (const command of active.rows) {
    if (command.state !== 'claimed') continue;
    const key = `${command.agent_id}:${command.turn_request_id}`;
    if (!assignments.has(key)) assignments.set(key, command);
  }
  for (const command of assignments.values())
    await createAgentCommand(database, {
      roomId: cornerId,
      agentId: command.agent_id,
      sourceMessageId: command.source_message_id,
      turnRequestId: command.turn_request_id,
      action: 'stop',
      reason: 'corner_close',
      parent: command,
      retainDepth: true,
    });
  await database.query(
    `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled',NULL,NULL) ended FROM agent_commands WHERE room_id=$1 AND action IN ('input','resume','restart') AND state IN ('pending','claimed')) terminal`,
    [cornerId],
  );
  await database.query(`DELETE FROM agent_pending_attachments WHERE room_id=$1`, [cornerId]);
}


async function archiveCorner(database: SqlDatabase, cornerId: string): Promise<boolean> {
  return database.transaction(async database => {
    await lockCornerLifecycle(database, cornerId);
    await lockCornerArchivalAuthority(database);
    if (!(await database.query(`SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL FOR KEY SHARE`, [cornerId])).rowCount)
      throw new Error('corner not found');
    await cancelCornerAgentCommands(database, cornerId);
    // Match command output: command locks precede the Room archival write lock.
    const changed = await database.query(
      `UPDATE rooms SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL`, [cornerId]);
    await abandonCornerWorkflowRuns(database, cornerId);
    await deleteCornerWakeSources(database, [cornerId]);
    await releaseArchivedCornerHolds(database, [cornerId]);
    return Boolean(changed.rowCount);
  });
}

/** A confirmed merge is an event; callers never write archive state themselves. */
export async function archiveCornerState(database: SqlDatabase, cornerId: string): Promise<boolean> {
  return (await advanceCorner(database, cornerId, { kind: 'merged', contents: {} })).archived === true;
}

export async function advanceCorner(
  database: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
): Promise<CornerAdvance> {
  // Admission is not a committed activity fact. Preserve the queue's lock
  // order (queue -> command -> Room); its committed event updates the machine.
  if (event.kind === 'command') return database.transaction(async db => {
    const current = (await db.query<{ machine: CornerMachine | null }>('SELECT machine FROM corner_facts WHERE corner_id=$1', [cornerId])).rows[0]?.machine ?? { state: 'idle' as const };
    const plan = transitionCorner(current, { facts: { archived: false, turnRunning: false }, event });
    const command = plan.wakes.length ? await createAgentCommand(db, event.command) : undefined;
    return { state: current.state, accepted: Boolean(command), ...(command ? { command } : {}) };
  });
  return database.transaction(async (db) => {
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    if (!corner) return { accepted: false, state: undefined };
    const head = corner.lifecycle.pr?.headSha ?? (event.kind === 'push' ? event.headSha : undefined);
    await ensureSystemIdentity(db);
    const row = (await db.query<CornerIdleRow>(cornerIdleSql('$1', true), [cornerId])).rows[0];
    const sourceHead =
      event.kind === 'checks'
        ? (
            await db.query<{ head: string | null }>(
              `SELECT system_event->'object'->>'headSha' head FROM messages WHERE id=$1 AND room_id=$2`,
              [event.sourceMessageId, cornerId],
            )
          ).rows[0]?.head
        : undefined;
    const checkSource = (
      await db.query<{ id: string; followup: boolean }>(
        `SELECT id,COALESCE((system_event->'payload'->>'followup')::boolean,false) followup FROM messages WHERE room_id=$1
      AND system_event->>'kind'=$2 AND (system_event->'object'->>'headSha' IS NULL OR system_event->'object'->>'headSha'=$3)
      ORDER BY created_at DESC,id DESC LIMIT 1`,
        [
          cornerId,
          corner.lifecycle.checks === 'failing' ? 'check-failed' : 'check-passed',
          head ?? null,
        ],
      )
    ).rows[0];
    const ended = head ? await blockingReview(db, cornerId, head) : undefined;
    const completed = head
      ? (
          await db.query<{ id: string; findings: string | null }>(
            `SELECT command.id,result.text findings
      FROM agent_commands command LEFT JOIN messages result ON result.id=command.result_message_id
      WHERE command.room_id=$1 AND command.review_context->>'headSha'=$2
        AND command.review_context->'pullRequest'=$3::jsonb AND command.review_context->>'purpose' IS NULL
        AND command.action='input' AND ($4::text IS NULL OR command.agent_id=$4) AND NOT EXISTS (SELECT 1 FROM agent_turns running
          WHERE running.room_id=command.room_id AND running.agent_id=command.agent_id
            AND running.request_id=command.turn_request_id AND running.status='working' AND ${workingTurnFreshSql('running')})
        AND (command.state='complete' OR command.state='cancelled' AND EXISTS (
          SELECT 1 FROM agent_turns turn WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
            AND turn.request_id=command.turn_request_id AND turn.status<>'working'))
      ORDER BY command.completed_at DESC NULLS LAST,command.created_at DESC LIMIT 1`,
            [cornerId, head, JSON.stringify(corner.lifecycle.pr?.number), corner.configured_reviewer_id],
          )
        ).rows[0]
      : undefined;
    const evidence = ended
      ? (
          await db.query<{ text: string }>(
            'SELECT result.text FROM agent_commands command JOIN messages result ON result.id=command.result_message_id WHERE command.id=$1',
            [ended],
          )
        ).rows[0]?.text
      : undefined;
    const active = (
      await db.query<{ worker: boolean; reviewer: boolean; conflict: boolean }>(
        `SELECT
      EXISTS(SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2
        AND state IN ('pending','claimed') AND action IN ('input','resume') AND reason<>'report' AND ${currentCornerCommandTargetSql('agent_commands')}) worker,
      EXISTS(SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$3 AND (state IN ('pending','claimed') OR EXISTS(SELECT 1 FROM agent_turns running
          WHERE running.room_id=agent_commands.room_id AND running.agent_id=agent_commands.agent_id
            AND running.request_id=agent_commands.turn_request_id AND running.status='working' AND ${workingTurnFreshSql('running')}))
        AND action='input' AND review_context->>'purpose' IS NULL
        AND review_context->>'headSha'=$4 AND review_context->'pullRequest'=$5::jsonb
        AND COALESCE((review_context->>'briefRevision')::int,0)=COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1),0)) reviewer,
      EXISTS(SELECT 1 FROM agent_commands delivered JOIN messages source ON source.id=delivered.source_message_id
        WHERE delivered.room_id=$1 AND delivered.reason='corner_merge_conflict'
          AND source.system_event->'object'->>'headSha'=$4) conflict`,
        [
          cornerId,
          corner.worker_agent_id,
          corner.configured_reviewer_id,
          head ?? null,
          JSON.stringify(corner.lifecycle.pr?.number ?? null),
        ],
      )
    ).rows[0];
    const waitText = row?.waiting_item_id
      ? (
          await db.query<{ text: string | null }>(
            `SELECT COALESCE(
      (SELECT private_payload->>'text' FROM agent_commands WHERE id=$1),
      (SELECT text FROM messages WHERE id=$1)) text`,
            [row.waiting_item_id],
          )
        ).rows[0]?.text
      : undefined;
    const gate =
      head && corner.lifecycle.pr?.number
        ? await cornerMergeGate(db, cornerId, { number: corner.lifecycle.pr.number, headSha: head })
        : undefined;
    const facts: CornerMachineFacts = {
      archived: corner.archived,
      locked: corner.locked,
      lifecycle: corner.lifecycle,
      headSha: head,
      turnRunning: row?.worker_active === true || active?.worker === true,
      reviewerActive: row?.reviewer_active === true || active?.reviewer === true,
      approved: gate?.approved,
      mergeHeld: gate?.held,
      mergeConflictDelivered: active?.conflict,
      draftReadyFailure: (corner.lifecycle as CornerLifecycleView & { draftReadyFailure?: { headSha?: string } }).draftReadyFailure?.headSha === head && Boolean(head),
      reviewerConfigured: independentReviewerConfigured(corner),
      ...(/^blocked:/.test(waitText ?? '') ? { waitReason: 'blocked' as const } : {}),
      ...(ended || completed
        ? {
            reviewEnded: {
              id: ended ?? completed!.id,
              ...(ended
                ? { findings: evidence ?? 'The reviewer requested changes on this head.' }
                : {}),
            },
          }
        : {}),
      ...(row && row.waiting_item_id && row.waiting_reason
        ? {
            blocker: {
              reason: row.waiting_reason,
              itemId: row.waiting_item_id,
              ...(row.waiting_kind ? { blocker: { kind: row.waiting_kind } } : {}),
            },
          }
        : {}),
      checkSourceId:
        sourceHead && sourceHead !== head
          ? 'stale'
          : event.kind === 'checks'
            ? event.sourceMessageId
            : checkSource?.id ?? (corner.lifecycle.checks === 'failing' && head
              ? `cache:${head}` : undefined),
      checkFollowup: checkSource?.followup,
      checkAttempt: (corner.lifecycle.checksSummary as { attempt?: number } | undefined)?.attempt,
      idleSince: row?.idle_since,
      idleEligible: row
        ? !row.suppressed && !row.worker_active && !row.reviewer_active && !row.blocking
        : false,
    };
    const prior = corner.machine ?? { state: 'idle' };
    const plan = transitionCorner(prior, { facts, event });
    if (plan.suppression) return { state: prior.state, accepted: false };
    const archived = plan.state.state === 'archived' && !corner.archived &&
      (event.kind === 'closed' || event.kind === 'merged' || corner.lifecycle.outcome === 'landed' || corner.lifecycle.pr?.mergedAt)
      ? await archiveCorner(db, cornerId) : false;
    if (event.kind === 'closed') await db.query(
      `UPDATE corner_github_cache SET lifecycle=lifecycle||'{"lifecycle":"done","checks":"unknown"}'::jsonb WHERE corner_id=$1`, [cornerId]);
    let wakeResult: RevisionWake | undefined;
    const effects = [...(plan.state.effects ?? [])];
    for (const effect of plan.wakes) {
      let result: Applied = OK;
      const sourceId = event.kind === 'checks' ? event.sourceMessageId : checkSource?.id;
      switch (effect.kind) {
        case 'merge-conflict': {
          const source =
            event.kind === 'merge-conflict'
              ? event.sourceMessageId
              : (
                  await systemLine(db, {
                    id: createHash('sha256')
                      .update(
                        `beeline:${cornerId}:github:merge-conflict:${corner.lifecycle.pr?.number}:${head}`,
                      )
                      .digest('hex'),
                    roomId: cornerId,
                    authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
                    subject: GITHUB_SUBJECT,
                    verb: systemMessage('agent-command.found-merge-conflicts-in'),
                    object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
                  })
                ).id;
          const command = corner.worker_agent_id
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId: corner.worker_agent_id,
                sourceMessageId: source,
                reason: 'corner_merge_conflict',
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
        case 'open': {
          const command =
            event.kind === 'open' && event.command
              ? await createAgentCommand(db, event.command)
              : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
        case 'revision': {
          if (event.kind !== 'brief-revised') break;
          const agentId = corner.worker_agent_id
            ? await firstHealthyAgent(db, cornerId, [corner.worker_agent_id])
            : null;
          const command = agentId
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId,
                sourceMessageId: event.sourceMessageId,
                reason: 'corner_brief_revision',
                parent: event.command,
                retainDepth: true,
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : { reason: 'No reachable implementer for the revision' }) },
          };
          break;
        }
        case 'checks-failed':
          if (!corner.worker_agent_id) {
            await noteReviewDispatchFailure(db, cornerId, head ?? 'checks', 'the corner has no implementer');
            result = { ok: true, wake: { queued: false, reason: 'the corner has no implementer' } };
          } else if (facts.checkSourceId && corner.worker_agent_id) {
            const command = await createAgentCommand(db, {
              roomId: cornerId,
              agentId: corner.worker_agent_id,
              sourceMessageId: sourceId ?? null,
              ...(!sourceId ? { id: createHash('sha256').update(`cached-checks:${cornerId}:${corner.lifecycle.pr?.number}:${head}:${facts.checkAttempt ?? 0}`).digest('hex'),
                privatePayload: { kind: 'lifecycle' as const, authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId,
                  text: `Failing checks on head ${head}: ${corner.lifecycle.checksSummary?.failing.length ? corner.lifecycle.checksSummary.failing.join(', ') : 'the recorded checks failed; read the current checks for details'}. Fix these recorded failures.` } } : {}),
              reason: 'corner_check',
            });
            if (command && !sourceId) await db.query(`UPDATE agent_commands SET review_context=jsonb_build_object(
              'cornerId',$2::text,'headSha',$3::text,'pullRequest',$4::int,'briefRevision',
              COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$2::uuid),0),'purpose','repair') WHERE id=$1`,
              [command.id,cornerId,head,corner.lifecycle.pr?.number]);
            result = {
              ok: true,
              wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
            };
          }
          break;
        case 'review': {
          const reviewer = await reachableReviewer(db, cornerId, corner, sourceId ?? cornerId);
          if (!reviewer) {
            result = await noteReviewBlocked(
              db,
              cornerId,
              corner,
              head!,
              'the configured reviewer is unreachable',
              false,
            );
            break;
          }
          const source =
            event.kind === 'checks' && sourceId ? sourceId :
            (
              await systemLine(db, {
                roomId: cornerId,
                authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
                subject: GITHUB_SUBJECT,
                verb: systemMessage('corner-lifecycle.requested-review-of'),
                object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
              })
            ).id;
          const queued = await queueReviewerCommand(db, {
            roomId: cornerId,
            agentId: reviewer,
            sourceMessageId: source,
            reason: event.kind === 'checks' ? 'subscribed_event' : 'corner_review_dispatch',
          });
          result = queued.command
            ? { ok: true, wake: { queued: true, agentId: reviewer } }
            : queued.blocked
              ? OK
              : await noteReviewBlocked(
                  db,
                  cornerId,
                  corner,
                  head!,
                  `the reviewer command could not be queued${queued.error ? `: ${queued.error}` : ''}`,
                );
          // Lost/cancelled unclaimed review commands are recoverable. Durable
          // command facts, rather than an effect receipt, suppress live reviews.
          break;
        }
        case 'review-gap':
          result = await noteMissingReviewer(
            db,
            cornerId,
            corner,
            `${corner.lifecycle.pr?.number}:${head}`,
          );
          break;
        case 'review-findings':
          result = await noteReviewBlocked(
            db,
            cornerId,
            corner,
            `${head}:${facts.reviewEnded!.id}`,
            `the reviewer completed its review of the current head ${head}.\n${facts.reviewEnded!.findings}`,
            false,
          );
          break;
        case 'review-no-verdict':
          result = await noteMissingReviewVerdict(db, cornerId, corner, head!);
          break;
        case 'land':
          if (corner.worker_agent_id) {
            const command = await createAgentCommand(db, {
              id: createHash('sha256')
                .update(`corner-land:${cornerId}:${corner.lifecycle.pr?.number}:${head}`)
                .digest('hex'),
              roomId: cornerId,
              agentId: corner.worker_agent_id,
              sourceMessageId: null,
              reason: 'corner_land',
              privatePayload: {
                kind: 'lifecycle',
                authorId: SYSTEM_IDENTITY_ID,
                fromRoomId: cornerId,
                text: `A yes is recorded on ${head} and checks passed. Call merge_corner through the normal merge gate.`,
              },
            });
            result = {
              ok: true,
              wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
            };
          }
          break;
        case 'merge-refused': {
          if (event.kind !== 'merge-refused') break;
          const line = await systemLine(db, {
            roomId: cornerId,
            authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
            subject: GITHUB_SUBJECT,
            verb: systemMessage('corner-lifecycle.refused-to-merge'),
            object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
            consequence: event.reason,
          });
          const command = corner.worker_agent_id
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId: corner.worker_agent_id,
                sourceMessageId: line.id,
                reason: 'corner_merge_refused',
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
      }
      if (result.wake) wakeResult = result.wake;
      if (!['review', 'command'].includes(effect.kind) && (result.wake?.queued || !result.wake))
        effects.push(effect.key);
    }
    for (const notice of plan.notifications) {
      if (notice.kind === 'draft') await reportToCommander(db, cornerId, corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
        systemMessage('agent-command.blocked-pr-is-a-draft-marking-it-ready-for-review-failed'), undefined,
        createHash('sha256').update(`draft-blocked:${cornerId}:${head}`).digest('hex'));
      if (notice.kind === 'idle' && row) {
        await reportToCommander(
          db,
          cornerId,
          SYSTEM_IDENTITY_ID,
          `blocked: Corner ${row.name} is idle. Resume it, set a hold, or close it.`,
          undefined,
          createHash('sha256').update(`idle:${cornerId}:${row.idle_since}`).digest('hex'),
          { automatic: true, agentOnly: true, wakeInCorner: true, idleSince: row.idle_since },
        );
      }
      // Explicit reports, owed asks and action cards already deliver to their
      // commander. The machine records the wait; it never broadcasts to Room people.
      effects.push(notice.key);
    }
    // Committed command activity invalidates idle delivery immediately through its fact guard.
    await db.query(
      `SELECT (terminal.ended).* FROM (SELECT beeline_end_agent_turn(agent_commands.id,agent_commands.generation_id,'cancelled','stale_idle_alert',NULL) ended
      FROM agent_commands WHERE state='pending' AND reason='report' AND private_payload->>'authorId'=$3
        AND private_payload->>'idleSince' IS NOT NULL AND COALESCE(private_payload->>'originCornerId',private_payload->>'fromRoomId')=$1::text
        AND private_payload->>'idleSince' IS DISTINCT FROM $2::text) terminal`,
      [cornerId, plan.state.state === 'idle' ? facts.idleSince : null, SYSTEM_IDENTITY_ID],
    );
    const state = { ...plan.state, effects };
    await db.query(
      'UPDATE corner_facts SET machine=$2::jsonb WHERE corner_id=$1 AND machine IS DISTINCT FROM $2::jsonb',
      [cornerId, JSON.stringify(state)],
    );
    return {
      state: state.state,
      accepted: true,
      ...(archived ? { archived: true } : {}),
      ...(wakeResult ? { wake: wakeResult } : {}),
    };
  });
}

/** Delivery diagnostic reads exact-target command evidence, never the broad Review badge. */
export function cornerReviewWokenSql(cornerId: string): string {
  return `EXISTS(SELECT 1 FROM agent_commands review JOIN rooms corner ON corner.id=review.room_id
    JOIN rooms parent ON parent.id=corner.parent_id JOIN corner_github_cache cache ON cache.corner_id=corner.id WHERE corner.id=${cornerId}
      AND review.agent_id=${cornerReviewerSql()} AND review.action='input'
      AND review.state IN ('pending','claimed','complete') AND review.review_context->>'purpose' IS NULL
      AND review.review_context->>'headSha'=cache.lifecycle->'pr'->>'headSha'
      AND review.review_context->'pullRequest'=cache.lifecycle->'pr'->'number')`;
}

/** Zero checks need the commander's yes; other review gaps retain their handback. */
async function noteMissingReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headKey: string,
): Promise<Applied> {
  if (corner.lifecycle.checksSummary?.total === 0) {
    const command = corner.worker_agent_id
      ? await createAgentCommand(db, {
          id: createHash('sha256').update(`zero-check-ready:${cornerId}:${headKey}`).digest('hex'),
          roomId: cornerId,
          agentId: corner.worker_agent_id,
          sourceMessageId: null,
          privatePayload: {
            text: "This pull request has no checks and no reviewer. Landing needs your commander's yes. Ask your commander using your normal report tool.",
            authorId: SYSTEM_IDENTITY_ID,
            fromRoomId: cornerId,
            kind: 'lifecycle',
          },
          reason: 'corner_review_needed',
        })
      : undefined;
    return {
      ok: true,
      wake: command
        ? { queued: true, agentId: corner.worker_agent_id! }
        : {
            queued: false,
            reason: 'The implementer cannot be woken to ask its commander for a merge decision',
          },
    };
  }
  return noteReviewBlocked(
    db,
    cornerId,
    corner,
    headKey,
    systemMessage('corner-lifecycle.no-reviewer-is-configured'),
  );
}

/**
 * One handback for every review gap. The implementer owns arranging another
 * review or reporting the blocker up the chain; a passive transcript note
 * alone cannot make that happen. A stable episode key dedupes fact replays.
 */
async function noteReviewBlocked(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headKey: string,
  reason: string,
  reportCommander = true,
): Promise<Applied> {
  const episode = `${cornerId}:${headKey}:${reason}`;
  if (reportCommander)
    await reportToCommander(
      db,
      cornerId,
      SYSTEM_IDENTITY_ID,
      systemMessage('corner-lifecycle.blocked', reason),
      undefined,
      createHash('sha256').update(`review-gap:${episode}`).digest('hex'),
    );
  const command = corner.worker_agent_id
    ? await createAgentCommand(db, {
        id: createHash('sha256').update(`review-needed:${episode}`).digest('hex'),
        roomId: cornerId,
        agentId: corner.worker_agent_id,
        sourceMessageId: null,
        privatePayload: {
          text: `${corner.lifecycle.checks === 'passing' ? 'Checks passed; ' : ''}${reason}; arrange review or report the blocker to its commander`,
          authorId: SYSTEM_IDENTITY_ID,
          fromRoomId: cornerId,
          kind: 'lifecycle',
        },
        reason: 'corner_review_needed',
      })
    : undefined;
  const wakeResult = command
    ? { queued: true, agentId: corner.worker_agent_id! }
    : {
        queued: false,
        reason: systemMessage('corner-lifecycle.the-implementer-cannot-be-woken-to-arrange-review'),
      };
  if (!command) await noteReviewDispatchFailure(db, cornerId, headKey, wakeResult.reason!);
  return { ok: true, wake: wakeResult };
}

async function noteReviewDispatchFailure(
  db: SqlDatabase,
  cornerId: string,
  headSha: string,
  reason: string,
): Promise<void> {
  await reportToCommander(
    db,
    cornerId,
    SYSTEM_IDENTITY_ID,
    systemMessage('corner-lifecycle.blocked', reason),
    undefined,
    createHash('sha256').update(`review-dispatch:${cornerId}:${headSha}:${reason}`).digest('hex'),
  );
}

// Compare check results, not refresh timestamps, attempts or run URLs.
const reviewChecksSql = `jsonb_build_object('status',lifecycle->>'checks','checks',
  (SELECT jsonb_agg(jsonb_build_object('name',item->>'name','status',item->>'status') ORDER BY item->>'name')
   FROM jsonb_array_elements(COALESCE(lifecycle->'checksSummary'->'checks','[]'::jsonb)) item))`;

/** Exhausted empty reviews are a private missing-verdict handback, never a completed review. */
async function noteMissingReviewVerdict(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headSha: string,
): Promise<Applied> {
  const text = `blocked: the reviewer ended without a verdict on head ${headSha}; arrange review or restore reviewer access`;
  const key = `${cornerId}:${corner.lifecycle.pr?.number}:${headSha}`;
  await reportToCommander(
    db,
    cornerId,
    SYSTEM_IDENTITY_ID,
    text,
    undefined,
    createHash('sha256').update(`review-no-verdict:${key}`).digest('hex'),
    { automatic: true, agentOnly: true },
  );
  const command = corner.worker_agent_id
    ? await createAgentCommand(db, {
        id: createHash('sha256')
          .update(`review-no-verdict-worker:${key}`)
          .digest('hex'),
        roomId: cornerId,
        agentId: corner.worker_agent_id,
        sourceMessageId: null,
        privatePayload: {
          text,
          authorId: SYSTEM_IDENTITY_ID,
          fromRoomId: cornerId,
          kind: 'lifecycle',
        },
        reason: 'corner_review_needed',
      })
    : undefined;
  return {
    ok: true,
    wake: { queued: Boolean(command), ...(command ? { agentId: corner.worker_agent_id! } : {}) },
  };
}

/**
 * The reviewer's finished review of this head (callers have already checked
 * for an approval on the head), while the corner was still in review. Another
 * review wake for the same head would only repeat that verdict. A later brief
 * revision does not reopen it: the code is unchanged. A new head does.
 * Delivered failed/blocked reports retain their head even if checks changed
 * during the turn; a failed execution without a delivered decision does not.
 */
export async function blockingReview(
  db: SqlDatabase,
  cornerId: string,
  headSha: string | null,
): Promise<string | undefined> {
  if (!headSha) return undefined;
  return (
    await db.query<{ id: string }>(
      `SELECT command.id FROM agent_commands command
       JOIN rooms corner ON corner.id=command.room_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN messages source ON source.id=command.source_message_id
       JOIN agent_turns turn ON turn.room_id=command.room_id
         AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
       LEFT JOIN LATERAL (SELECT true delivered FROM agent_commands repair
         WHERE repair.room_id=command.room_id AND repair.parent_command_id=command.id AND repair.reason='order'
           AND repair.private_payload->>'authorId'=command.agent_id
           AND repair.review_context->>'purpose'='repair'
           AND repair.review_context->>'headSha'=$2
           AND repair.review_context->'pullRequest'=command.review_context->'pullRequest'
           AND repair.private_payload->>'text' ~* $3 LIMIT 1) repair_verdict ON true
       WHERE command.room_id=$1 AND command.action='input'
         AND (command.state='complete' AND turn.status='complete'
           OR COALESCE(command.private_payload->>'reportedOutcome',command.report_outcome) IN ('failed','blocked') OR repair_verdict.delivered)
         AND (EXISTS (SELECT 1 FROM messages verdict
           WHERE verdict.room_id=command.room_id AND verdict.author_id=command.agent_id
             AND (verdict.id=command.result_message_id OR verdict.request_id=command.turn_request_id
               OR verdict.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb))))
             AND verdict.deleted_at IS NULL AND verdict.text ~* $3)
           OR EXISTS (SELECT 1 FROM agent_commands report
             WHERE report.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb)))
               AND report.private_payload->>'authorId'=command.agent_id AND report.private_payload->>'text' ~* $3)
           OR repair_verdict.delivered)
         AND command.agent_id=${cornerReviewerSql()}
         AND (command.reason='corner_review_dispatch'
           OR (command.reason IN ('agent_tag','order') AND command.review_context IS NOT NULL
             AND command.review_context->>'purpose' IS DISTINCT FROM 'repair')
           OR (command.reason='subscribed_event' AND source.system_event->>'kind'='check-passed'))
         AND command.review_context->>'headSha'=$2
         AND command.review_context->'pullRequest'=(
           SELECT lifecycle->'pr'->'number' FROM corner_github_cache WHERE corner_id=$1)
       ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
      [
        cornerId,
        headSha,
        `${REVIEW_VERDICT_SQL}|(^|\\n)[[:space:]]*blocked:[[:space:]]*[^[:space:]]`,
      ],
    )
  ).rows[0]?.id;
}

async function queueReviewerCommand(
  db: SqlDatabase,
  input: Parameters<typeof createAgentCommand>[1],
): Promise<{ command?: CommandRow; error?: string; blocked?: boolean }> {
  // The wake names the brief revision current at dispatch, so a reviewer
  // never reviews against a superseded one.
  const brief = (
    await db.query<{ revision: number }>(
      `SELECT revision FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
      [input.roomId],
    )
  ).rows[0];
  const context = (
    await db.query<{ context: Record<string, unknown> | null }>(
      `SELECT CASE WHEN lifecycle->'pr'->>'headSha' IS NOT NULL AND lifecycle->'pr'->>'number' IS NOT NULL
       THEN jsonb_build_object('cornerId',corner_id,'headSha',lifecycle->'pr'->>'headSha',
       'pullRequest',lifecycle->'pr'->'number','briefRevision',$2::int,
       'checks',${reviewChecksSql}) ELSE NULL END context
     FROM corner_github_cache WHERE corner_id=$1`,
      [input.roomId, brief?.revision ?? 0],
    )
  ).rows[0]?.context;
  const headSha = typeof context?.headSha === 'string' ? context.headSha : undefined;
  const rawPull = context?.pullRequest;
  const pullRequest =
    typeof rawPull === 'number'
      ? rawPull
      : typeof rawPull === 'string' && /^\d+$/.test(rawPull)
        ? Number(rawPull)
        : null;
  if (
    headSha !== undefined &&
    (await refuseVerdictedReviewerWake(db, input.roomId, input.agentId, headSha, pullRequest))
  )
    return { blocked: true };
  const prior = (
    await db.query<{ text: string }>(
      `SELECT result.text FROM agent_commands command JOIN messages result ON result.id=command.result_message_id
     WHERE command.room_id=$1 AND command.agent_id=$2 AND command.review_context IS NOT NULL
       AND command.state='complete' ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
      [input.roomId, input.agentId],
    )
  ).rows[0]?.text;
  // A rejected insert must leave this transaction usable so the failure line
  // can commit. A broken connection still propagates rather than pretending
  // the reviewer was woken.
  await db.query('SAVEPOINT corner_reviewer_dispatch');
  try {
    const command = await createAgentCommand(db, {
      ...input,
      wakeNote: [
        context
          ? `Current handoff target: PR #${context.pullRequest} at ${context.headSha}. Older heads in the conversation are historical.`
          : '',
        brief
          ? `Review against brief revision ${brief.revision}, the corner's current brief at this dispatch.`
          : '',
        prior ? `Prior reviewer verdict and evidence (historical context):\n${prior}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    if (command)
      await db.query('UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1', [
        command.id,
        context ? JSON.stringify(context) : null,
      ]);
    if (command) command.review_context = context as Record<string, unknown> | null;
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return { command };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT corner_reviewer_dispatch');
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return {
      error:
        error instanceof Error
          ? error.message.slice(0, 160)
          : systemMessage('corner-lifecycle.unknown-dispatch-error'),
    };
  }
}

/** A reviewer is configured and is not the implementer it would review. */
function independentReviewerConfigured(corner: CornerRow): boolean {
  return (
    Boolean(corner.configured_reviewer_id) &&
    corner.configured_reviewer_id !== corner.worker_agent_id
  );
}

/**
 * Which reviewer a green head wakes, or undefined (after naming the gap in the
 * corner) when the configured reviewer cannot be reached. A configured
 * reviewer who is not a current member is never "no reviewer": it does not
 * fall through to the no-reviewer path.
 */
async function reachableReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  sourceMessageId: string,
): Promise<string | undefined> {
  const reviewerId = corner.configured_reviewer_id;
  if (!reviewerId || reviewerId === corner.worker_agent_id) return undefined;
  if (!corner.reviewer_parent_member) {
    await noteUnreachableReviewer(db, {
      cornerId,
      sourceMessageId,
      reviewerId,
      reviewerKind: corner.configured_reviewer_kind,
      reviewerName: corner.configured_reviewer_name,
      reason: REVIEWER_NOT_PARENT_MEMBER,
    });
    return undefined;
  }
  return (await readableByReviewer(db, cornerId, reviewerId, sourceMessageId))
    ? reviewerId
    : undefined;
}

/**
 * Dispatch only when the reviewer can read the corner; a missing projection
 * is repaired, an unreachable reviewer is named instead of rerouting the
 * review to the owner (whose daemon would post it under the owner's name).
 */
async function readableByReviewer(
  db: SqlDatabase,
  cornerId: string,
  reviewerAgentId: string,
  sourceMessageId: string,
): Promise<boolean> {
  if (await repairReviewerCornerMembership(db, cornerId, reviewerAgentId)) return true;
  const reviewer = (
    await db.query<{ kind: string; name: string }>(`SELECT kind,name FROM identities WHERE id=$1`, [
      reviewerAgentId,
    ])
  ).rows[0];
  await noteUnreachableReviewer(db, {
    cornerId,
    sourceMessageId,
    reviewerId: reviewerAgentId,
    reviewerKind: reviewer?.kind ?? null,
    reviewerName: reviewer?.name ?? null,
    reason: REVIEWER_NOT_CORNER_MEMBER,
  });
  return false;
}

const REVIEWER_NOT_PARENT_MEMBER = 'not a current member of the parent Room';
const REVIEWER_NOT_CORNER_MEMBER = 'not a current member of this corner';

/**
 * A configured reviewer that cannot be dispatched is named in the corner, not
 * collapsed into the no-reviewer path. Deterministic id so a later retry of
 * the same gap does not spam.
 */
async function noteUnreachableReviewer(
  db: SqlDatabase,
  input: {
    cornerId: string;
    sourceMessageId: string;
    reviewerId: string;
    reviewerKind: string | null;
    reviewerName: string | null;
    reason: string;
  },
): Promise<void> {
  console.error(
    `[corner-lifecycle] ${input.cornerId}: reviewer ${input.reviewerId} ${input.reason}; reporting to the commander`,
  );
  const id = createHash('sha256')
    .update(`beeline:${input.cornerId}:reviewer-unreachable:${input.reviewerId}:${input.reason}`)
    .digest('hex');
  await reportToCommander(
    db,
    input.cornerId,
    input.reviewerId,
    systemMessage(
      'corner-lifecycle.blocked-configured-reviewer-could-not-be-reached',
      input.reviewerName ?? input.reviewerId,
      input.reason,
    ),
    undefined,
    id,
  );
}

export type CornerMergeGate = {
  /** A reviewer is configured. */
  reviewerExists: boolean;
  /**
   * A yes said on this exact head: a configured reviewer agent's PASS, or a
   * current Workspace owner or admin's order, or the zero-check commander's yes.
   */
  approved: boolean;
  evidenceMissing?: boolean;
  held: boolean;
  holds: Awaited<ReturnType<typeof activeCornerHolds>>;
  /** Everything but checks: a yes on this head and no hold. */
  open: boolean;
};

export type CornerMergeabilityInput = {
  checks: string;
  evidenceMissing?: boolean;
  approved: boolean;
  held: boolean;
  holds: readonly { id: string; holderId?: string; holderName?: string | null }[];
  archived: boolean;
  merged?: boolean;
  expectedHeadSha?: string | null;
  currentHeadSha: string;
  mergeability?: string;
};

/** One verdict and refusal reason for both the checks read and merge command. */
export function cornerMergeability(input: CornerMergeabilityInput) {
  const reasons = [
    input.merged ? 'the pull request is already merged' : '',
    input.archived ? 'the corner is closed' : '',
    input.expectedHeadSha && input.expectedHeadSha !== input.currentHeadSha
      ? 'PR head changed; checks and approval must match the corner head'
      : '',
    input.mergeability === 'draft' ? 'PR is a draft' : '',
    input.checks !== 'passed' ? `checks are ${input.checks}` : '',
    input.evidenceMissing
      ? 'missing review attachments: attach the screenshots or files claimed by the verdict'
      : input.approved
        ? ''
        : 'no yes on this head',
    input.held
      ? `a hold stands${input.holds.length ? `: ${input.holds.map((hold) => `${hold.id}${hold.holderName ? ` (${hold.holderName}, ${hold.holderId ?? ''})` : ''}`).join('; ')}` : ''}`
      : '',
  ].filter(Boolean);
  return {
    mergeAllowed: reasons.length === 0,
    ...(reasons.length ? { blockedReason: reasons.join('; ') } : {}),
  };
}

/**
 * The merge gate for one exact PR head, minus the checks verdict (the caller
 * supplies that live from GitHub). Shared by `pr_checks_status` and the server
 * merge, so the gate an agent reads is the gate `landCorner` merges on.
 */
export async function cornerMergeGate(
  db: SqlDatabase,
  cornerId: string,
  head: { number: number; headSha: string },
): Promise<CornerMergeGate> {
  db = new CornerAccessDatabase(db);
  const rows = await db.query<{
    configured_reviewer_id: string | null;
    approved: boolean;
    holds: CornerMergeGate['holds'];
  }>(
    `SELECT ${cornerReviewerSql()} configured_reviewer_id,
              EXISTS (
                SELECT 1 FROM corner_merge_approvals approval
                WHERE approval.corner_id=fact.corner_id AND approval.pull_request_number=$2
                  AND approval.head_sha=$3
                  AND (
                    -- A configured reviewer agent, still a parent member.
                    EXISTS (
                      SELECT 1 FROM memberships member
                      JOIN identities reviewer ON reviewer.id=member.identity_id AND reviewer.kind='agent'
                      WHERE member.room_id=parent.id AND member.identity_id=approval.approved_by
                        AND approval.approved_by IS DISTINCT FROM ${cornerImplementerSql('fact', 'corner')}
                        AND member.removed_at IS NULL
                        AND approval.approved_by=${cornerReviewerSql()}
                    )
                    -- Or a current Workspace owner or admin.
                    OR EXISTS (
                      SELECT 1 FROM memberships workspace_member
                      JOIN identities person ON person.id=workspace_member.identity_id AND person.kind='human'
                      WHERE workspace_member.workspace_id=corner.workspace_id
                        AND workspace_member.room_id IS NULL
                        AND workspace_member.identity_id=approval.approved_by
                        AND workspace_member.removed_at IS NULL
                        AND workspace_member.role IN ('owner','admin')
                    )
                  )
              ) approved,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hold.id::text,'actorId',hold.actor_id,
                'holderId',COALESCE(hold.set_by_agent_id,hold.actor_id),'holderName',(SELECT name FROM identities WHERE id=COALESCE(hold.set_by_agent_id,hold.actor_id)),
                'sourceMessageId',hold.source_message_id,'sourceAuthorId',hold.source_author_id,
                'sourceAuthorName',(SELECT name FROM identities WHERE id=hold.source_author_id),'sourceText',hold.source_text,
                'standing',hold.standing,'setAt',hold.set_at::text) ORDER BY hold.set_at,hold.id)
                FROM corner_merge_holds hold WHERE hold.corner_id=fact.corner_id AND hold.released_at IS NULL),
                '[]'::jsonb) holds
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       WHERE fact.corner_id=$1`,
    [cornerId, head.number, head.headSha],
  );
  const corner = rows.rows[0];
  if (!corner) throw new Error('corner not found');
  if (!corner.approved && !corner.configured_reviewer_id) {
    const approval = (
      await db.query<{ approved_by: string }>(
        `SELECT approved_by FROM corner_merge_approvals
       WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3`,
        [cornerId, head.number, head.headSha],
      )
    ).rows[0];
    if (approval) corner.approved = await isZeroCheckCommander(db, cornerId, approval.approved_by);
  }
  const approval = (
    await db.query<{ approved_by: string }>(
      `SELECT approval.approved_by FROM corner_merge_approvals approval JOIN identities reviewer
       ON reviewer.id=approval.approved_by AND reviewer.kind='agent'
     WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3`,
      [cornerId, head.number, head.headSha],
    )
  ).rows[0];
  const evidenceMissing = Boolean(
    approval && (await missingReviewAttachments(db, cornerId, head, approval.approved_by)),
  );
  if (evidenceMissing) corner.approved = false;
  const held = corner.holds.length > 0;
  return {
    ...(evidenceMissing ? { evidenceMissing: true } : {}),
    reviewerExists: Boolean(corner.configured_reviewer_id),
    approved: corner.approved,
    held,
    holds: corner.holds,
    open: corner.approved && !held,
  };
}

/**
 * Rechecks local merge authority under the run lock after the live gate read,
 * immediately before GitHub is asked to merge: the corner is open, the head
 * is unchanged, the brief still assigns repository work, a yes stands on this
 * head and no hold stands. Nothing is stored. GitHub's expected-head merge
 * merges a pull request at most once; a concurrent second attempt reads the
 * live pull request and confirms the merge instead of reporting a refusal.
 */
export async function confirmCornerMergeAuthority(
  database: SqlDatabase,
  cornerId: string,
  headSha: string,
  onBlocked?: (reason: string) => void,
): Promise<boolean> {
  const blocked = (reason: string) => {
    onBlocked?.(reason);
    return false;
  };
  return database.transaction(async (db) => {
    await lockCornerLifecycle(db, cornerId);
    const corner = await loadCorner(db, cornerId);
    const pr = corner?.lifecycle.pr;
    if (!corner) return blocked('the corner no longer exists');
    if (corner.archived) return blocked('the corner is archived');
    if (!pr?.number) return blocked('the corner has no pull request');
    if (pr.headSha !== headSha) return blocked('the pull request head changed before the merge');
    // A brief revised during the GitHub read is seen here: revisions take this lock.
    await assertCornerBriefAllowsMerge(db, cornerId);
    const gate = await cornerMergeGate(db, cornerId, { number: pr.number, headSha });
    if (!gate.open)
      return blocked(
        gate.evidenceMissing
          ? 'missing review attachments: attach the screenshots or files claimed by the verdict'
          : gate.held
            ? 'a hold stands'
            : 'no yes on this head',
      );
    return true;
  });
}

export async function deleteStoredCornerWorkflows(database: SqlDatabase): Promise<number> {
  const deleted = await database.query(
    `DELETE FROM workspace_skills skill
     WHERE skill.slug=$1 AND skill.kind='workflow'
       AND EXISTS (
         SELECT 1 FROM workspace_skill_versions version
         WHERE version.skill_id=skill.id AND version.extractor_version='corner-workflow-v1'
       )`,
    [CORNER_LIFECYCLE_SLUG],
  );
  if (deleted.rowCount)
    console.log(
      `deleteStoredCornerWorkflows: deleted ${deleted.rowCount} stored corner workflow(s)`,
    );
  return deleted.rowCount;
}
