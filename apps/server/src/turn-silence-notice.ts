/**
 * First silence after a delivered message: one durable Room line, and for a
 * hiccup only, reopen the original command so the helper answers it again
 * without another human request. Only that one turn is failed or requeued; the
 * helper process is never told to exit.
 *
 * Triggered from the failed receipt and from ConnectionPresence's existing
 * 90-second demotion / stalled-working-turn timers — never a poll.
 */
import { isAgentSignInHarness, type AgentSignInHarness } from '@beeline/api-contract/daemon';
import {
  classifyTurnSilence,
  escalateExhaustedHiccup,
  phraseTurnSilence,
  shouldRestartHiccup,
  type TurnSilenceKind,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { restateSystemLine, systemLine, type SystemPhrase } from './system-line.js';
import { reassignFailedWorkflowRole } from './workflow-runs.js';
import { reassignFailedCornerReviewer } from './corner-lifecycle.js';

export const TURN_FAILURE_REASON_MAX = 200;

export type TurnSilenceOutcome = {
  readonly kind: TurnSilenceKind;
  readonly hiccupRestart: boolean;
  readonly updateRequeued: boolean;
  readonly attempt: number;
};

const NO_RESTART: TurnSilenceOutcome = {
  kind: 'hiccup',
  hiccupRestart: false,
  updateRequeued: false,
  attempt: 0,
};

export function turnSilenceLockKey(roomId: string, requestId: string, agentId: string): string {
  return `silence:${roomId}:${requestId}:${agentId}`;
}

/**
 * A claimed command's lease already makes it reclaimable by any helper that
 * next asks for this room's commands (`claimAgentCommand` allows it the
 * moment `lease_expires_at<=now()`), but nothing ever asks again for a room
 * or corner whose live loop stopped watching it. Two paths that would
 * otherwise notice miss it entirely: an agent-to-agent dispatch
 * (`agent_tag`, `subscribed_event`) has no human-authored source message
 * for `noteFirstSilence`'s own trigger lookup to report against, so the
 * ordinary 90-second stall path calls `reassignFailedCornerReviewer` /
 * `reassignFailedWorkflowRole` but never reaches `inscribeSilence` to free
 * the command itself; and a corner reviewer reassignment with no configured
 * fallback leaves the original claim exactly where it was even when it does
 * run. Left alone, such a command sits `claimed` with an expired lease
 * forever, and a later arrival in the same room can be forced to wait
 * behind it the moment some helper claims it again. This sweep terminates
 * it outright on the lease alone -- no human trigger, no fallback reviewer,
 * and no live loop required -- so a lane can never stay blocked waiting on
 * an execution that is already gone. Runs on the background reconciliation
 * cycle, well past `COMMAND_LEASE_SECONDS` so a heartbeat's own transient
 * gap is never mistaken for abandonment.
 */
export const EXPIRED_LEASE_SWEEP_GRACE_MS = 5 * 60_000;

export async function reclaimExpiredCommandLeases(
  database: SqlDatabase,
  live: LiveHub,
  graceMs = EXPIRED_LEASE_SWEEP_GRACE_MS,
): Promise<number> {
  const stuck = await database.query<{
    id: string;
    room_id: string;
    agent_id: string;
    turn_request_id: string;
    generation_id: string | null;
  }>(
    `SELECT id,room_id,agent_id,turn_request_id,generation_id FROM agent_commands
     WHERE state='claimed' AND action IN ('input','resume')
       AND lease_expires_at<now()-make_interval(secs => $1::double precision/1000)
     ORDER BY lease_expires_at LIMIT 200`,
    [graceMs],
  );
  let terminated = 0;
  for (const command of stuck.rows) {
    await database.transaction((db) =>
      reassignFailedWorkflowRole(db, {
        roomId: command.room_id,
        requestId: command.turn_request_id,
        agentId: command.agent_id,
      }),
    );
    await reassignFailedCornerReviewer(database, {
      roomId: command.room_id,
      requestId: command.turn_request_id,
      agentId: command.agent_id,
    });
    const completed = await database.transaction(async (db) => {
      const result = await db.query(
        `UPDATE agent_commands SET state='complete',completed_at=now()
         WHERE id=$1 AND state='claimed' AND lease_expires_at<now()`,
        [command.id],
      );
      if (!result.rowCount) return false;
      await db.query(
        `UPDATE agent_turns SET status='failed',
           failure_reason='the command lease expired with no live execution',created_at=now()
         WHERE room_id=$1 AND agent_id=$2 AND request_id=$3 AND status='working'
           AND generation_id IS NOT DISTINCT FROM $4`,
        [command.room_id, command.agent_id, command.turn_request_id, command.generation_id],
      );
      return true;
    });
    if (!completed) continue;
    terminated += 1;
    live.publish({
      type: 'invalidate',
      roomId: command.room_id,
      reason: 'postgres:agent_commands',
      targetAgentId: command.agent_id,
      agentId: command.agent_id,
    });
  }
  return terminated;
}

export async function noteFirstSilence(
  database: SqlDatabase,
  live: LiveHub,
  input: {
    readonly roomId: string;
    readonly requestId: string;
    readonly agentId: string;
    /** Required once a command is claimed; stale executions produce no output. */
    readonly generationId?: string | null;
    readonly reason?: string | null;
    readonly reasonKind?: string;
    /** Presence stall timer: no receipt wrapper completes an exhausted command. */
    readonly stalled?: boolean;
  },
): Promise<TurnSilenceOutcome> {
  // Independent of the human-trigger notice below: a workflow dispatch's
  // triggering message is normally agent-authored (the previous role
  // holder's handoff card, or the run's own start card), and a review
  // dispatch's is the server's check-passed fact, neither of which the
  // notice's own trigger requirement below would satisfy. Failing a
  // list-bound role or reviewer over must not depend on there being a human
  // further up the chain.
  await database.transaction((db) =>
    reassignFailedWorkflowRole(db, {
      roomId: input.roomId,
      requestId: input.requestId,
      agentId: input.agentId,
    }),
  );
  await reassignFailedCornerReviewer(database, {
    roomId: input.roomId,
    requestId: input.requestId,
    agentId: input.agentId,
  });

  const trigger = (
    await database.query<{ agent_name: string; login_handle: string | null; harness: string | null }>(
      `SELECT COALESCE(NULLIF(agent.name,''),'The agent') agent_name,
              agent.handle login_handle,
              (SELECT harness FROM agents WHERE agent_id=$3) harness
       FROM messages message
       JOIN identities requester ON requester.id=message.author_id AND requester.kind='human'
       JOIN identities agent ON agent.id=$3
       WHERE message.id=$2 AND message.presentation IN ('message','system')
         AND (message.room_id=$1 OR message.room_id=(SELECT parent_id FROM rooms WHERE id=$1))`,
      [input.roomId, input.requestId, input.agentId],
    )
  ).rows[0];
  if (!trigger) return NO_RESTART;

  return database.transaction((db) =>
    inscribeSilence(
      db,
      live,
      input,
      trigger.agent_name,
      trigger.login_handle && isAgentSignInHarness(trigger.harness)
        ? { handle: trigger.login_handle, harness: trigger.harness }
        : undefined,
    ),
  );
}

async function inscribeSilence(
  database: SqlDatabase,
  live: LiveHub,
  input: {
    readonly roomId: string;
    readonly requestId: string;
    readonly agentId: string;
    readonly generationId?: string | null;
    readonly reason?: string | null;
    readonly reasonKind?: string;
    readonly stalled?: boolean;
  },
  agentName: string,
  login: { handle: string; harness: AgentSignInHarness } | undefined,
): Promise<TurnSilenceOutcome> {
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    turnSilenceLockKey(input.roomId, input.requestId, input.agentId),
  ]);

  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, TURN_FAILURE_REASON_MAX);
  const classified = classifyTurnSilence(reason || undefined, input.reasonKind);
  const command = (
    await database.query<{
      id: string;
      state: 'pending' | 'claimed';
      hiccup_attempts: number;
      generation_id: string | null;
    }>(
      `SELECT id,state,hiccup_attempts,generation_id FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action IN ('input','resume')
         AND ((state='pending' AND $4::text IS NULL) OR
              (state='claimed' AND generation_id=$4))
       ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [input.roomId, input.agentId, input.requestId, input.generationId ?? null],
    )
  ).rows[0];
  // A watchdog belongs to one execution. Once that generation has completed,
  // or a successor owns the command, its delayed callback is stale and must
  // leave no failure line, turn transition, or retry behind.
  if (!command && input.generationId != null) return NO_RESTART;
  const canIncrement = command?.state === 'claimed';
  const attempt = canIncrement ? command!.hiccup_attempts + 1 : (command?.hiccup_attempts ?? 0);
  const restart = Boolean(canIncrement && shouldRestartHiccup(classified.kind, attempt));
  const givingUp = classified.kind === 'hiccup' && canIncrement && attempt >= 3;
  // An auth-shaped fault gets the same bounded hiccup retries as any other
  // transient condition; only once those are exhausted does the Room line
  // (and the card it carries) identify failed provider authentication
  // without assuming whether the helper's login expired.
  const renderClassified = givingUp ? escalateExhaustedHiccup(classified) : classified;
  const phrase = phraseTurnSilence(agentName, renderClassified, {
    givingUp,
    restarting: restart,
    ...(login ? { login } : {}),
  });
  const systemPhrase: SystemPhrase = {
    subject: { kind: 'agent', id: input.agentId, name: agentName },
    verb: phrase.verb,
    consequence: phrase.consequence,
  };
  const card = {
    requestId: input.requestId,
    agentId: input.agentId,
    state: 'failed',
    silenceKind: renderClassified.kind,
  };

  await database.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status,failure_reason)
     VALUES($1,$2,$3,'failed',$4)
     ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
       status='failed',
       failure_reason=CASE
         WHEN agent_turns.status='working' THEN EXCLUDED.failure_reason
         ELSE agent_turns.failure_reason
       END,
       created_at=now()
     WHERE agent_turns.status IN ('working','failed')`,
    [input.roomId, input.requestId, input.agentId, reason || classified.fault || null],
  );

  const recent = (
    await database.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'
         AND card->>'requestId'=$2 AND card->>'agentId'=$3 AND card->>'state'='failed'
         AND ($4::boolean OR created_at>now()-interval '10 minutes')
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [input.roomId, input.requestId, input.agentId, classified.kind === 'update-interrupted'],
    )
  ).rows[0];
  if (recent) {
    if (restart || givingUp || classified.kind === 'update-interrupted')
      await restateSystemLine(database, recent.id, systemPhrase, card);
  } else {
    await systemLine(database, {
      roomId: input.roomId,
      ...systemPhrase,
      cardType: 'turn-failed',
      card,
      afterMessageId: input.requestId,
    });
  }

  let hiccupRestart = false;
  let updateRequeued = false;
  if (restart && command) {
    const reopened = await reopenCommand(
      database,
      live,
      input.roomId,
      input.agentId,
      command.id,
      command.generation_id,
      attempt,
    );
    hiccupRestart = reopened;
  } else if (classified.kind === 'update-interrupted' && command) {
    // Presence may have already reopened this exact command while the helper
    // was installing. Its generation-free receipt still replaces the generic
    // failure line and confirms that the original request is pending.
    updateRequeued = command.state === 'pending' || await reopenCommand(
      database,
      live,
      input.roomId,
      input.agentId,
      command.id,
      command.generation_id,
      command.hiccup_attempts,
    );
  } else if (classified.kind === 'offline' && command?.state === 'claimed') {
    // The helper never posted a turn. Leave the original request eligible for
    // `beeline start` instead of completing it the way a spent hiccup is.
    await reopenCommand(
      database,
      live,
      input.roomId,
      input.agentId,
      command.id,
      command.generation_id,
      command.hiccup_attempts,
    );
  } else if (
    classified.kind === 'hiccup' &&
    !restart &&
    command?.state === 'claimed' &&
    input.stalled
  ) {
    // Stall path has no execute wrapper to complete the exhausted command.
    await database.query(
      `UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1 AND state='claimed'`,
      [command.id],
    );
  }

  return { kind: classified.kind, hiccupRestart, updateRequeued, attempt };
}

async function reopenCommand(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string,
  agentId: string,
  commandId: string,
  generationId: string | null,
  hiccupAttempts: number,
): Promise<boolean> {
  const updated = await database.query(
    `UPDATE agent_commands SET
       state='pending',generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL,
       completed_at=NULL,hiccup_attempts=$2
     WHERE id=$1 AND state='claimed' AND generation_id=$3`,
    [commandId, hiccupAttempts, generationId],
  );
  if (!updated.rowCount) return false;
  live.publish({
    type: 'invalidate',
    roomId,
    reason: 'postgres:agent_commands',
    targetAgentId: agentId,
    agentId,
  });
  return true;
}
