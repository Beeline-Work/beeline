import { cornerLifecycleSql } from './corner-github-cache.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import type { CornerLifecycleView, CornerStateFacts, DerivedCornerState } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { cornerImplementerSql } from './corner-worker.js';
import { CornerEvent } from './corner-lifecycle.js';



export type CornerRow = {
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


export async function loadCorner(db: SqlDatabase, cornerId: string, retain = true): Promise<CornerRow | undefined> {
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
       ${retain ? 'FOR UPDATE OF fact' : ''}`,
      [cornerId],
    )
  ).rows[0];
}


export type CornerCheckSummary = NonNullable<CornerLifecycleView['checksSummary']> & {
  reportedHeadSha?: string;
  reportedFailing?: readonly string[];
  failureFollowupSent?: boolean;
  partialRepairSent?: boolean;
  attempt?: number;
  statusChangedAt?: number;
};

export type CornerCheckObservation = {
  headSha: string;
  previousHeadSha?: string;
  prior?: CornerCheckSummary;
  next: CornerCheckSummary;
  workerBusy: boolean;
};

export type CornerChecksPlan = {
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

export type MachineWake = {
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

export type MachineNotification = { kind: 'idle' | 'waiting' | 'draft'; key: string };

export type CornerMachineFacts = CornerStateFacts & {
  headSha?: string;
  approved?: boolean;
  mergeHeld?: boolean;
  mergeConflictDelivered?: boolean;
  lostEffects?: string[];
  draftReadyFailure?: boolean;
  waitReason?: 'blocked' | 'user_action' | 'question';
  reviewerConfigured?: boolean;
  reviewEnded?: { id: string; findings?: string; reported?: boolean };
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
  const redKey = `red:${headSha}:${f.checkAttempt ?? 0}:${f.checkFollowup || (event.kind === 'checks' && event.followup) ? f.checkSourceId : 'first'}`;
  // A receipt cannot suppress a wake whose durable command was lost.
  const effects = (current.headSha === headSha && current.pullRequest === pullRequest
    ? [...(current.effects ?? [])] : [])
    .filter(key => (key !== `merge-conflict:${headSha ?? ''}` || f.mergeConflictDelivered !== false) &&
      !(f.lostEffects ?? []).includes(key));
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
      redKey,
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
