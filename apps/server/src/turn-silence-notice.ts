/**
 * First silence after a delivered message: one durable Room line, and for a
 * hiccup only, reopen the original command so the recovered helper answers
 * without another human request.
 *
 * Triggered from the failed receipt and from ConnectionPresence's existing
 * 90-second demotion / stalled-working-turn timers — never a poll.
 */
import {
  classifyTurnSilence,
  phraseTurnSilence,
  shouldRestartHiccup,
  type TurnSilenceKind,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { restateSystemLine, systemLine, type SystemPhrase } from './system-line.js';

export const TURN_FAILURE_REASON_MAX = 200;

export type TurnSilenceOutcome = {
  readonly kind: TurnSilenceKind;
  readonly hiccupRestart: boolean;
  readonly attempt: number;
};

const NO_RESTART: TurnSilenceOutcome = { kind: 'hiccup', hiccupRestart: false, attempt: 0 };

export function turnSilenceLockKey(roomId: string, requestId: string, agentId: string): string {
  return `silence:${roomId}:${requestId}:${agentId}`;
}

export async function noteFirstSilence(
  database: SqlDatabase,
  live: LiveHub,
  input: {
    readonly roomId: string;
    readonly requestId: string;
    readonly agentId: string;
    readonly reason?: string | null;
    readonly reasonKind?: string;
    /** Receipt path: the helper already has WriteResult.hiccupRestart. */
    readonly liveRestart?: boolean;
    /** Skip live restart when a new helper process already announced. */
    readonly helperAlreadyRestarted?: boolean;
  },
): Promise<TurnSilenceOutcome> {
  const trigger = (
    await database.query<{ agent_name: string }>(
      `SELECT COALESCE(NULLIF(agent.name,''),'The agent') agent_name
       FROM messages message
       JOIN identities requester ON requester.id=message.author_id AND requester.kind='human'
       JOIN identities agent ON agent.id=$3
       WHERE message.id=$2 AND message.presentation IN ('message','system')
         AND (message.room_id=$1 OR message.room_id=(SELECT parent_id FROM rooms WHERE id=$1))`,
      [input.roomId, input.requestId, input.agentId],
    )
  ).rows[0];
  if (!trigger) return NO_RESTART;

  return database.transaction((db) => inscribeSilence(db, live, input, trigger.agent_name));
}

async function inscribeSilence(
  database: SqlDatabase,
  live: LiveHub,
  input: {
    readonly roomId: string;
    readonly requestId: string;
    readonly agentId: string;
    readonly reason?: string | null;
    readonly reasonKind?: string;
    readonly liveRestart?: boolean;
    readonly helperAlreadyRestarted?: boolean;
  },
  agentName: string,
): Promise<TurnSilenceOutcome> {
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    turnSilenceLockKey(input.roomId, input.requestId, input.agentId),
  ]);

  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, TURN_FAILURE_REASON_MAX);
  const classified = classifyTurnSilence(reason || undefined, input.reasonKind);
  const command = (
    await database.query<{ id: string; state: string; hiccup_attempts: number }>(
      `SELECT id,state,hiccup_attempts FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action IN ('input','resume')
       ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [input.roomId, input.agentId, input.requestId],
    )
  ).rows[0];
  const canIncrement = Boolean(
    command && command.state !== 'pending' && command.state !== 'cancelled',
  );
  const attempt = canIncrement ? command!.hiccup_attempts + 1 : (command?.hiccup_attempts ?? 0);
  const restart = Boolean(canIncrement && shouldRestartHiccup(classified.kind, attempt));
  const phrase = phraseTurnSilence(agentName, classified, {
    givingUp: classified.kind === 'hiccup' && canIncrement && attempt >= 3,
    restarting: restart,
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
    silenceKind: classified.kind,
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
         AND created_at>now()-interval '10 minutes'
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [input.roomId, input.requestId, input.agentId],
    )
  ).rows[0];
  const givingUp = classified.kind === 'hiccup' && canIncrement && attempt >= 3;
  if (recent) {
    if (restart || givingUp) await restateSystemLine(database, recent.id, systemPhrase, card);
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
  if (restart && command) {
    const reopened = await reopenCommand(
      database,
      live,
      input.roomId,
      input.agentId,
      command.id,
      attempt,
    );
    hiccupRestart = reopened;
    if (reopened && input.liveRestart && !input.helperAlreadyRestarted) {
      live.publish({
        type: 'invalidate',
        roomId: input.roomId,
        reason: 'hiccup-restart',
        targetAgentId: input.agentId,
        agentId: input.agentId,
        hiccupAttempt: attempt,
      });
    }
  } else if (classified.kind === 'offline' && command?.state === 'claimed') {
    // The helper never posted a turn. Leave the original request eligible for
    // `beeline start` instead of completing it the way a spent hiccup is.
    await reopenCommand(
      database,
      live,
      input.roomId,
      input.agentId,
      command.id,
      command.hiccup_attempts,
    );
  } else if (
    classified.kind === 'hiccup' &&
    !restart &&
    command?.state === 'claimed' &&
    input.liveRestart
  ) {
    // Stall path has no execute wrapper to complete the exhausted command.
    await database.query(
      `UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1 AND state='claimed'`,
      [command.id],
    );
  }

  return { kind: classified.kind, hiccupRestart, attempt };
}

async function reopenCommand(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string,
  agentId: string,
  commandId: string,
  hiccupAttempts: number,
): Promise<boolean> {
  const updated = await database.query(
    `UPDATE agent_commands SET
       state='pending',generation_id=NULL,lease_expires_at=NULL,claimed_at=NULL,
       completed_at=NULL,hiccup_attempts=$2
     WHERE id=$1 AND state IN ('claimed','complete')`,
    [commandId, hiccupAttempts],
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
