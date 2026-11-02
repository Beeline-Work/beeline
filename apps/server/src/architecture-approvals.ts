import type { CommandRow } from './agent-command.js';
import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import { OPERATOR_OWNER_ID } from './operator-system-dm.js';

/**
 * The owner's yes on one exact pull request head that relaxes
 * `architecture/invariants.json`. CI reads it through
 * `GET /v1/public/architecture-approvals`; a new commit needs a new yes.
 */
export const ARCHITECTURE_APPROVALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS architecture_relax_approvals (
 repository text NOT NULL, pull_request_number integer NOT NULL, head_sha text NOT NULL,
 approved_by text NOT NULL, command_message_id text NOT NULL, agent_id text NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(repository,pull_request_number,head_sha)
);
`;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD = /^[0-9a-f]{40}$/;

type ApprovalKey = { repository: string; pullRequest: number; headSha: string };

function approvalKey(input: { repository?: unknown; pullRequest?: unknown; headSha?: unknown }): ApprovalKey | undefined {
  const pullRequest = Number(input.pullRequest);
  const repository = String(input.repository ?? '').toLowerCase();
  const headSha = String(input.headSha ?? '').toLowerCase();
  if (!REPOSITORY.test(repository) || !HEAD.test(headSha) || !Number.isInteger(pullRequest) || pullRequest < 1) return undefined;
  return { repository, pullRequest, headSha };
}

/**
 * Records the owner's yes. The turn must be commanded by the owner's own
 * message, and that message or the message it answers must name the pull
 * request number and the head commit (at least its first 7 characters).
 */
export async function approveArchitectureRelax(database: SqlDatabase, command: CommandRow | undefined, agentId: string,
  input: { repository: string; pullRequest: number; headSha: string }) {
  const key = approvalKey(input);
  if (!key) throw new CommandRefusalError('repository must be owner/name, pullRequest a positive number, headSha a full 40-character commit', 400);
  if (!command || command.agent_id !== agentId)
    throw new CommandRefusalError('An architecture relaxation needs an active command from the owner', 403);
  const root = (await database.query<{ id: string; text: string }>(
    `SELECT m.id,concat_ws(E'\\n',m.text,answered.text) text FROM messages m
     JOIN identities owner ON owner.id=m.author_id AND owner.kind='human'
     LEFT JOIN messages answered ON answered.id=m.reply_to_message_id AND answered.deleted_at IS NULL
     WHERE m.id=$1 AND m.author_id=$2 AND m.deleted_at IS NULL`,
    [command.root_source_message_id, OPERATOR_OWNER_ID],
  )).rows[0];
  if (!root) throw new CommandRefusalError('An architecture relaxation needs the owner\'s own message commanding this turn', 403);
  const text = root.text.toLowerCase();
  const namesPullRequest = new RegExp(`(?:#|/pull/)${key.pullRequest}(?!\\d)`).test(text);
  const namesHead = (text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).some(sha => key.headSha.startsWith(sha));
  if (!namesPullRequest || !namesHead)
    throw new CommandRefusalError(`The owner's message, or the message it answers, must name PR #${key.pullRequest} and head ${key.headSha.slice(0, 7)}`, 403);
  await database.query(
    `INSERT INTO architecture_relax_approvals(repository,pull_request_number,head_sha,approved_by,command_message_id,agent_id)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [key.repository, key.pullRequest, key.headSha, OPERATOR_OWNER_ID, root.id, agentId],
  );
  return { approved: true as const, ...key };
}

/** The public read CI makes: was this exact head approved? Unknown input reads as no. */
export async function readArchitectureApproval(database: SqlDatabase, query: URLSearchParams): Promise<{ approved: boolean }> {
  const key = approvalKey({ repository: query.get('repository'), pullRequest: query.get('pullRequest'), headSha: query.get('head') });
  if (!key) return { approved: false };
  const found = await database.query(
    `SELECT 1 FROM architecture_relax_approvals WHERE repository=$1 AND pull_request_number=$2 AND head_sha=$3`,
    [key.repository, key.pullRequest, key.headSha],
  );
  return { approved: Boolean(found.rowCount) };
}
