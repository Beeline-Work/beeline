import { type PhoneIdentityRow as IdentityRow, phoneIdentity as identity } from '../phone-identity.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash, randomBytes } from 'node:crypto';
import { HUMAN_CORNER_TITLE_MAX_LENGTH } from '@beeline/api-contract/phone';
import type { AgentGrantView, RoomViewMember } from '@beeline/api-contract/phone';
import { type AgentGrantStatus } from '@beeline/api-contract/agent-grants';
import { type SqlDatabase } from '../database.js';




export const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);


export const DURABLE_KINDS = [0, 9, 9000, 9001, 9002, 9007, 9008, 30078, 39000, 39001, 39002];


/**
 * How long after a claim the connect wizard may still rename its agent from
 * the terminal. Long enough for the daemon install and the person to read the
 * line; short enough that a leaked pairing code is not a standing handle.
 */
export const CONNECT_RENAME_WINDOW_MS = 15 * 60 * 1_000;

export const SLOW_ROOM_READ_MS = 500;

/** Archived corners come ten at a time, newest closure first. */
export const ARCHIVED_CORNER_PAGE = 10;

export const OPEN_CORNER_PAGE = 30;

/** A profile paints a recent ledger window; older entries stay in the store. */
export const PROFILE_GRANT_LIMIT = 100;

export type MemberGrantRow = {
  id: string;
  kind: AgentGrantView['kind'];
  target: string;
  reason: string;
  status: AgentGrantStatus;
  room_id: string;
  room_name: string | null;
  auto: boolean;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date | null;
  agent: IdentityRow;
  requester: IdentityRow;
  decider: IdentityRow | null;
  script: unknown;
};

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agents a Room may list after its reviewer, tried in order (`agent-health.ts`). */

/** Where the next archived page starts: the last row's exact closure time and id. */
export type ArchivedCornerCursor = { readonly micros: string; readonly id: string };


/** Reads a `nextArchived` cursor (`<archived_at µs>,<corner id>`); anything else is not one. */
export function parseArchivedCornerCursor(
  raw: string | null | undefined,
): ArchivedCornerCursor | undefined {
  const parsed = raw?.match(
    /^(\d{1,19}),([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
  return parsed ? { micros: parsed[1]!, id: parsed[2]! } : undefined;
}

export const OPTIONAL_ENRICHMENT_DEADLINE_MS = 1_000;

export const ENRICHMENT_LOG_INTERVAL_MS = 60_000;

export function normalizeAgentName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 32 || !/^\p{L}[\p{L}\p{M}'’ -]*$/u.test(name))
    throw new Error('invalid agent name: must be a short spoken name');
  return name;
}


export function normalizeHumanCornerTitle(value: unknown): string {
  if (typeof value === 'string' && /\s/.test(value))
    throw new Error('corner title must not contain whitespace; use hyphens between words');
  const title = typeof value === 'string' ? value : '';
  if (!title) throw new Error('corner title is required');
  if (title.length > HUMAN_CORNER_TITLE_MAX_LENGTH)
    throw new Error(`corner title must be at most ${HUMAN_CORNER_TITLE_MAX_LENGTH} characters`);
  return title;
}


/**
 * Settled corner tool rows kept in the corner transcript after the turn
 * completes (#804). Own cap: they must never crowd out the 30-message
 * conversation window, and top-level Rooms never surface them.
 */
export function roomFilters(
  roomId: string,
  workspaceId: string,
  familyIds: readonly string[],
  members: readonly RoomViewMember[],
) {
  const h = [...new Set([workspaceId, roomId, ...familyIds])];
  const authors = [...new Set(members.map((member) => member.identity.pubkey))];
  return [
    { kinds: DURABLE_KINDS, '#h': h },
    ...(authors.length ? [{ kinds: [0], authors }] : []),
    {
      kinds: [30078],
      '#d': [`agent-draft:${roomId}`, `agent-thought:${roomId}`, `agent-presence:${roomId}`],
    },
  ];
}


export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The id of one window's access notice, shared by the immediate and deferred paths. */
export function mentionNoticeId(
  roomId: string,
  agentId: string,
  senderId: string,
  reason: string,
  bucket: number,
): string {
  return hash(`access-notice|${roomId}|${agentId}|${senderId}|${reason}|${bucket}`);
}

export function token(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function messageId(): string {
  return randomBytes(32).toString('hex');
}

export function unix(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}


/**
 * The author has read everything up to their own message, so their read mark
 * moves with the write (forward only, as `PhoneService.markRead` moves it):
 * the phone never spends a second request after every send. `updated_at`
 * stays where it was (the epoch on a new mark): it means "read here just now",
 * and the push gate holds pushes for 30 s after it. A reply sent from a
 * notification is not someone reading the Room, and a sender still in the
 * Room is already held by its view.
 */
export async function advanceAuthorReadMark(
  database: Pick<SqlDatabase, 'query'>,
  roomId: string,
  authorId: string,
  messageIdValue: string,
): Promise<void> {
  await database.query(
    `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
    SELECT $1,$2,message.created_at,$3,'epoch'::timestamptz FROM messages message
    WHERE message.id=$3 AND message.room_id=$1
    ON CONFLICT(room_id,identity_id) DO UPDATE SET message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id
    WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>(room_read_marks.message_created_at,room_read_marks.message_id)`,
    [roomId, authorId, messageIdValue],
  );
}


/**
 * How a system line names a person: their `@handle`, never a display name.
 *
 * A handle is the address a reader can actually use and it is unique; a display
 * name is neither, and two people can wear the same one. A person with no handle
 * is left unnamed by the caller rather than described by one.
 */
export function personMention(handle: string | null | undefined): string | undefined {
  const trimmed = handle?.trim().replace(/^@/, '');
  return trimmed ? systemMessage("phone-service.person-mention", trimmed) : undefined;
}


/** Grant decisions retain the owner-or-Workspace-manager authority axis. */
export const YOLO_AUTHORITY_MESSAGE = "Only the agent's owner or a workspace admin can change this";


/**
 * Who may accept a connector offer (R5, Q4): the person the agent addressed
 * or a Workspace manager. Named here so `server.ts` answers 403.
 */
export const CONNECTOR_OFFER_AUTHORITY_MESSAGE =
  'Only the person the agent addressed or a workspace admin can add this tool';


/** A wallet binds a signing key to one person; nobody can grant it for them. */
export const CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE =
  'Only the person the agent addressed can connect their own wallet';


/** Workspace, Room and corner management belongs to Workspace owners and admins. */
export const WORKSPACE_ADMIN_AUTHORITY_MESSAGE = 'workspace admins only';


/** Agent configuration belongs only to the human who connected that agent. */
export const AGENT_OWNER_AUTHORITY_MESSAGE = "Only the agent's owner can change this";


/** Trusty Squire spending belongs only to the spending agent's owner. */
export const SPENDING_OWNER_AUTHORITY_MESSAGE = 'Only its owner can approve this spending';


/** The same owner-only axis, for who may address an agent. */
export const ACCESS_POLICY_AUTHORITY_MESSAGE = AGENT_OWNER_AUTHORITY_MESSAGE;


/**
 * The Google Play review identity signs in without GitHub, so it holds no
 * GitHub token and must never acquire one: it cannot install the App, create or
 * link a repository, or bind itself to a GitHub account. Read-only repository
 * operations stay available and simply answer empty. This is the one place the
 * review identity differs from an ordinary person.
 */
export const REVIEW_IDENTITY_MESSAGE = 'GitHub access denied for the review identity';
