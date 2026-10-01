import type {
  AnswerStarPromptInput,
  AnswerStarPromptResult,
  StarPromptView,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

/**
 * The GitHub star card.
 *
 * Due once per milestone: the viewer's 3rd, 30th and 300th completed agent
 * reply (counted when the reply commits, across every Room and corner; cards
 * and failures never count). It shows on the first win after the milestone,
 * never on the count itself: an agent reply carrying an artifact, the
 * viewer's 👍 on an agent message, or a corner they commissioned landing or
 * closing. It stays hidden while the viewer is mid-conversation, right after
 * a failed turn or a correction, and once GitHub says they already starred.
 *
 * Starring only ever happens on the viewer's own tap, with their own token,
 * and nothing is gated on it (GitHub Acceptable Use Policies). "Not now"
 * waits for the next milestone; the close button and a star stop it for good.
 */
const STAR_PROMPT_REPOSITORY = 'Beeline-Work/beeline';
const STAR_PROMPT_URL = `https://github.com/${STAR_PROMPT_REPOSITORY}`;
export const STAR_PROMPT_MILESTONES: readonly number[] = [3, 30, 300];
const MID_CONVERSATION_SECONDS = 30;
const CORRECTION_WINDOW_MINUTES = 10;

export const GITHUB_STAR_PROMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS github_star_prompts (
  identity_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  replies integer NOT NULL DEFAULT 0,
  reached_milestone integer NOT NULL DEFAULT 0,
  reached_at timestamptz,
  answered_milestone integer NOT NULL DEFAULT 0,
  last_win_at timestamptz,
  closed text CHECK (closed IN ('dismissed','starred')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

interface StarPromptGitHub {
  repositoryStarred(viewerId: string, fullName: string): Promise<boolean | 'unknown'>;
  starRepository(viewerId: string, fullName: string): Promise<boolean>;
}

/**
 * The upsert that counts one committed agent reply toward the person whose
 * message started the command. A reply that carries an artifact is also a
 * win. `command` yields the command's `root_source_message_id`, `artifact`
 * is a boolean expression and `milestones` an int[] expression, so the agent
 * reply statement can run it as one of its own CTEs.
 */
export function starPromptReplySql(command: string, artifact: string, milestones: string): string {
  return `INSERT INTO github_star_prompts AS prompt(identity_id,replies,reached_milestone,reached_at,last_win_at)
     SELECT source.author_id,1,
       CASE WHEN 1=ANY(${milestones}) THEN 1 ELSE 0 END,
       CASE WHEN 1=ANY(${milestones}) THEN now() END,
       CASE WHEN ${artifact} THEN now() END
     FROM ${command} command
     JOIN messages source ON source.id=command.root_source_message_id
     JOIN identities person ON person.id=source.author_id
       AND person.kind='human' AND NOT person.hidden_from_roster
     LIMIT 1
     ON CONFLICT(identity_id) DO UPDATE SET
       replies=prompt.replies+1,
       reached_milestone=CASE WHEN prompt.replies+1=ANY(${milestones})
         THEN prompt.replies+1 ELSE prompt.reached_milestone END,
       reached_at=CASE WHEN prompt.replies+1=ANY(${milestones}) THEN now() ELSE prompt.reached_at END,
       last_win_at=CASE WHEN ${artifact} THEN now() ELSE prompt.last_win_at END,
       updated_at=now()`;
}

/** {@link starPromptReplySql} for a reply that is already committed. */
export async function recordStarPromptReply(
  database: SqlDatabase,
  reply: { roomId: string; agentId: string; requestId: string; messageId: string; artifact: boolean },
): Promise<void> {
  await database.query(
    starPromptReplySql(
      `(SELECT root_source_message_id FROM agent_commands
        WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND result_message_id=$4)`,
      '$6::boolean',
      '$5::int[]',
    ),
    [
      reply.roomId,
      reply.agentId,
      reply.requestId,
      reply.messageId,
      STAR_PROMPT_MILESTONES,
      reply.artifact,
    ],
  );
}

/** A win for the star card's timing, e.g. the person's 👍 on an agent message. */
export async function recordStarPromptWin(
  database: SqlDatabase,
  identityId: string,
): Promise<void> {
  await database.query(
    `INSERT INTO github_star_prompts(identity_id,last_win_at) VALUES($1,now())
     ON CONFLICT(identity_id) DO UPDATE SET last_win_at=now(),updated_at=now()`,
    [identityId],
  );
}

export async function readStarPrompt(
  database: SqlDatabase,
  viewerId: string,
  github?: StarPromptGitHub,
): Promise<StarPromptView> {
  const row = (
    await database.query<{
      reached_milestone: number;
      answered_milestone: number;
      due: boolean;
    }>(
      `SELECT prompt.reached_milestone,prompt.answered_milestone,
         GREATEST(prompt.last_win_at,(
           SELECT max(card.created_at) FROM corner_facts corner
           JOIN messages card ON card.room_id=corner.corner_id
             AND card.card_type='corner-workflow-handoff'
             AND card.card->>'toState' IN ('landed','closed')
           WHERE corner.commissioned_by=prompt.identity_id
         ))>=prompt.reached_at due
       FROM github_star_prompts prompt
       WHERE prompt.identity_id=$1 AND prompt.closed IS NULL
         AND prompt.reached_milestone>prompt.answered_milestone`,
      [viewerId],
    )
  ).rows[0];
  if (!row?.due) return { prompt: null };
  const held = (
    await database.query<{ held: boolean }>(
      `WITH rooms AS (
         SELECT room_id FROM memberships
         WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL
       )
       SELECT EXISTS(
           SELECT 1 FROM rooms JOIN messages message ON message.room_id=rooms.room_id
           WHERE message.author_id=$1
             AND message.created_at>now()-make_interval(secs=>$2)
         )
         OR COALESCE((
           SELECT turn.status='failed' FROM rooms
           CROSS JOIN LATERAL (
             SELECT status,created_at FROM agent_turns
             WHERE agent_turns.room_id=rooms.room_id
             ORDER BY created_at DESC LIMIT 1
           ) turn
           ORDER BY turn.created_at DESC LIMIT 1
         ),false)
         OR EXISTS(
           SELECT 1 FROM institutional_memory_correction_events correction
           WHERE correction.requester_identity_id=$1
             AND correction.workspace_id IN (
               SELECT workspace_id FROM memberships
               WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL
             )
             AND correction.created_at>now()-make_interval(mins=>$3)
         ) held`,
      [viewerId, MID_CONVERSATION_SECONDS, CORRECTION_WINDOW_MINUTES],
    )
  ).rows[0]?.held;
  if (held) return { prompt: null };
  if ((await github?.repositoryStarred(viewerId, STAR_PROMPT_REPOSITORY)) === true) {
    await database.query(
      `UPDATE github_star_prompts SET closed='starred',updated_at=now() WHERE identity_id=$1`,
      [viewerId],
    );
    return { prompt: null };
  }
  return {
    prompt: {
      milestone: row.reached_milestone,
      repository: STAR_PROMPT_REPOSITORY,
      url: STAR_PROMPT_URL,
    },
  };
}

export async function answerStarPrompt(
  database: SqlDatabase,
  viewerId: string,
  input: AnswerStarPromptInput,
  github?: StarPromptGitHub,
): Promise<AnswerStarPromptResult> {
  if (!STAR_PROMPT_MILESTONES.includes(input.milestone)) throw new Error('milestone is invalid');
  if (input.action === 'later') {
    await database.query(
      `INSERT INTO github_star_prompts(identity_id,answered_milestone) VALUES($1,$2)
       ON CONFLICT(identity_id) DO UPDATE SET
         answered_milestone=GREATEST(github_star_prompts.answered_milestone,$2),updated_at=now()`,
      [viewerId, input.milestone],
    );
    return { outcome: 'later' };
  }
  if (input.action !== 'star' && input.action !== 'dismiss') throw new Error('action is invalid');
  const starred =
    input.action === 'star' && github
      ? await github.starRepository(viewerId, STAR_PROMPT_REPOSITORY)
      : false;
  await database.query(
    `INSERT INTO github_star_prompts(identity_id,answered_milestone,closed) VALUES($1,$2,$3)
     ON CONFLICT(identity_id) DO UPDATE SET
       answered_milestone=GREATEST(github_star_prompts.answered_milestone,$2),
       closed=$3,updated_at=now()`,
    [viewerId, input.milestone, input.action === 'star' ? 'starred' : 'dismissed'],
  );
  if (input.action === 'dismiss') return { outcome: 'dismissed' };
  return starred ? { outcome: 'starred' } : { outcome: 'open', url: STAR_PROMPT_URL };
}
