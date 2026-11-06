import { phoneIdentity as identity } from '../phone-identity.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { scheduleDisplayTitle } from '../schedule-title.js';
import { modelChoiceLabel, readRepositoryOnboardingCard } from '@beeline/api-contract/phone';
import type { AgentDetailView, MessageSearchSnippetPart, RoomScheduleView, RoomViewMember, RoomViewMessage } from '@beeline/api-contract/phone';
import { cornerDisplayName, formatSystemLine, MESSAGE_REACTION_EMOJIS, type ArtifactAttachment, type AgentSignInCardView } from '@beeline/api-contract/phone';
import { isAgentReachable } from '@beeline/api-contract/agent-access';
import { mediaIdFromUrl } from '../media-ttl.js';
import { readVaultSaveCard } from '@beeline/api-contract/phone';
import { MemberRow, RoomHeaderRow, AttachmentFacts, MessageRow, RoomScheduleRow } from './types.js';
import { unix } from './values.js';


/** A held presence belongs to a live helper connection and does not age out. */
export function projectAgentPresence(
  body: NonNullable<MemberRow['presence_body']>,
  updatedAt: Date,
  roomId: string | null,
): NonNullable<RoomViewMember['presence']> {
  const held = body.held === true;
  const status = isAgentReachable(body.status, updatedAt.getTime(), Date.now(), held)
    ? 'online'
    : 'offline';
  return {
    status,
    observedAt: Math.max(body.observedAt, unix(updatedAt)),
    ...(held && status === 'online' ? { held: true as const } : {}),
    ...(roomId ? { roomId } : {}),
  };
}

export const MESSAGE_SEARCH_PAGE = 20;

/** A search that reads longer than this matches too much to be worth finishing. */
export const MESSAGE_SEARCH_STATEMENT_TIMEOUT = '1500ms';

// \x01/\x02 are stripped from the text before ts_headline marks matches with them.
export const MESSAGE_SEARCH_HEADLINE_OPTIONS =
  'StartSel="\x01", StopSel="\x02", MaxWords=30, MinWords=20, ShortWord=0';

/** A message search that hit its time limit: the query matches too much. */
export class MessageSearchTooBroadError extends Error {
  constructor() {
    super('message search query too broad');
    this.name = 'MessageSearchTooBroadError';
  }
}

export function messageSearchSnippet(headline: string): MessageSearchSnippetPart[] {
  const parts: MessageSearchSnippetPart[] = [];
  for (const piece of headline
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(\x01[^\x02]*\x02)/)) {
    if (!piece) continue;
    const match = piece.startsWith('\x01');
    parts.push({ text: match ? piece.slice(1, -1) : piece, match });
  }
  return parts;
}

export function messageOrder(left: RoomViewMessage, right: RoomViewMessage): number {
  return (
    (left.createdAtMs ?? left.createdAt * 1_000) - (right.createdAtMs ?? right.createdAt * 1_000) ||
    left.id.localeCompare(right.id)
  );
}

export function reviveDates<Row extends object>(row: Row, fields: readonly string[]): Row {
  const mutable = row as Record<string, unknown>;
  for (const field of fields) {
    const value = mutable[field];
    if (typeof value === 'string') mutable[field] = new Date(value);
  }
  return row;
}


export function selectedModelLabel(
  selected: string | null,
  catalog: AgentDetailView['catalog'],
): string | undefined {
  const axis = catalog.find((candidate) => candidate.category === 'model');
  return modelChoiceLabel(axis, selected ?? axis?.currentValue);
}

/**
 * The catalog's effort axis: a known effort category first; otherwise the
 * first axis that is neither the model nor Fast mode, so a harness naming its
 * effort category differently keeps its effort picker.
 */
export function effortCatalogAxis(
  catalog: AgentDetailView['catalog'],
): AgentDetailView['catalog'][number] | undefined {
  return (
    catalog.find((axis) =>
      ['thought_level', 'effort', 'reasoning_effort'].includes(axis.category),
    ) ??
    catalog.find(
      (axis) =>
        axis.category !== 'model' && !(axis.id === 'fast-mode' && axis.category === 'model_config'),
    )
  );
}

export function roomHeader(row: RoomHeaderRow, publicOrigin: string) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    name: row.name,
    ...(row.about ? { about: row.about } : {}),
    visibility: row.visibility,
    ...(row.reviewer_agent_id ? { reviewerAgentId: row.reviewer_agent_id } : {}),
    archived: Boolean(row.archived_at),
    createdAt: unix(row.created_at),
    updatedAt: unix(row.updated_at),
  };
}


/**
 * Stamp `expired` on every attachment whose media id has a tombstone
 * (`media-ttl.ts`). The message row is never edited: name, type and size stay
 * exactly as they were posted, and the client renders the loss rather than
 * guessing at a 410 it has not made yet.
 */
export function withAttachmentExpiry<Message extends RoomViewMessage>(
  messages: readonly Message[],
  expired: ReadonlySet<string>,
): Message[] {
  if (!expired.size) return [...messages];
  return messages.map((message) => {
    if (!message.attachments?.length) return message;
    const attachments = message.attachments.map((attachment) => {
      const id = mediaIdFromUrl(attachment.url);
      return id && expired.has(id) ? { ...attachment, expired: true } : attachment;
    });
    return attachments.some((attachment, index) => attachment !== message.attachments![index])
      ? { ...message, attachments }
      : message;
  });
}


/**
 * Stamp artifact-card facts onto attachments whose media id names a ready
 * object row: `{ kind:'artifact', title, author }` alongside the mime and size
 * the attachment already carries. Person file shares and agent artifacts
 * share this card. The message row is never edited.
 */
export function withArtifactFacts<Message extends RoomViewMessage>(
  messages: readonly Message[],
  artifacts: ReadonlyMap<string, ArtifactAttachment>,
): Message[] {
  if (!artifacts.size) return [...messages];
  return messages.map((message) => {
    if (!message.attachments?.length) return message;
    const attachments = message.attachments.map((attachment) => {
      const id = mediaIdFromUrl(attachment.url);
      const artifact = id ? artifacts.get(id) : undefined;
      return artifact ? { ...attachment, ...artifact } : attachment;
    });
    return attachments.some((attachment, index) => attachment !== message.attachments![index])
      ? { ...message, attachments }
      : message;
  });
}


/** Both attachment decorations in one place, so no read path forgets one. */
export function decorateAttachments<Message extends RoomViewMessage>(
  messages: readonly Message[],
  facts: AttachmentFacts,
): Message[] {
  return withArtifactFacts(withAttachmentExpiry(messages, facts.expired), facts.artifacts);
}


export function projectedMessage(
  row: MessageRow,
  publicOrigin: string,
  viewerId?: string,
): RoomViewMessage {
  const author = identity(
    {
      id: row.author_id,
      kind: row.author_kind,
      name: row.author_name,
      handle: row.author_handle,
      avatar: row.author_avatar,
      face_id: row.author_face,
    },
    publicOrigin,
  );
  const reactionIdentityById = new Map(
    (row.reaction_identities ?? []).map((reactor) => [reactor.id, reactor]),
  );
  const base: RoomViewMessage = {
    id: row.id,
    // A deleted message stays in its place as a system line (`deletedMessageEvent`).
    text: row.deleted_at
      ? row.system_event
        ? formatSystemLine(row.system_event)
        : systemMessage("phone-service.message-deleted")
      : row.text,
    createdAt: unix(row.created_at),
    createdAtMs: row.created_at.getTime(),
    ...(typeof row.version === 'number' ? { version: row.version } : {}),
    author,
    ...(!row.deleted_at && row.source_client ? { sourceClient: row.source_client } : {}),
    presentation: row.deleted_at ? 'system' : row.presentation,
    ...(row.deleted_at ? { deleted: true } : {}),
    ...(row.bookmarked ? { bookmarked: true } : {}),
    ...(row.feedback_reported ? { feedbackReported: true } : {}),
    ...(row.presentation === 'message'
      ? {
          reference: {
            channelId: row.room_id,
            eventId: row.id,
            rootId: row.root_message_id ?? row.id,
          },
        }
      : {}),
    ...(row.request_id
      ? { requestId: row.request_id, liveTurnId: row.turn_id ?? `live-turn:${row.request_id}` }
      : {}),
    ...(!row.deleted_at && row.attachments.length
      ? {
          attachments: (row.attachments as NonNullable<RoomViewMessage['attachments']>).map(
            (attachment) => ({
              ...attachment,
              url: attachment.url.startsWith('/')
                ? `${publicOrigin}${attachment.url}`
                : attachment.url,
              ...(attachment.previewUrl?.startsWith('/')
                ? { previewUrl: `${publicOrigin}${attachment.previewUrl}` }
                : {}),
              ...(attachment.thumbnailUrl?.startsWith('/')
                ? { thumbnailUrl: `${publicOrigin}${attachment.thumbnailUrl}` }
                : {}),
            }),
          ),
        }
      : {}),
    ...(!row.deleted_at && row.tagged_ids.length ? { mentionPubkeys: row.tagged_ids } : {}),
    ...(row.agent_model ? { agentModel: row.agent_model } : {}),
    ...(!row.deleted_at && Object.keys(row.reactions ?? {}).length
      ? {
          reactions: MESSAGE_REACTION_EMOJIS.flatMap((emoji) => {
            const reactors = (row.reactions ?? {})[emoji] ?? [];
            return reactors.length
              ? [
                  {
                    emoji,
                    count: reactors.length,
                    reacted: viewerId ? reactors.includes(viewerId) : false,
                    members: reactors.flatMap((reactorId) => {
                      const reactor = reactionIdentityById.get(reactorId);
                      return reactor ? [identity(reactor, publicOrigin)] : [];
                    }),
                  },
                ]
              : [];
          }),
        }
      : {}),
    ...(row.reply_to_message_id
      ? {
          reply: {
            channelId: row.room_id,
            eventId: row.reply_to_message_id,
            rootId: row.root_message_id ?? row.reply_to_message_id,
          },
        }
      : {}),
    ...(row.activity ? { activity: row.activity as NonNullable<RoomViewMessage['activity']> } : {}),
    ...(row.durable_fact ? { durableFact: row.durable_fact } : {}),
    ...(row.system_event ? { systemEvent: row.system_event } : {}),
  };
  if (!row.card_type || !row.card) return base;
  switch (row.card_type) {
    case 'away-warning': return { ...base, awayWarning: true };
    case 'vault-save': {
      const card = readVaultSaveCard(row.card);
      return card ? { ...base, vaultSave: card } : base;
    }
    case 'voice-call':
      return { ...base, voiceCall: row.card as NonNullable<RoomViewMessage['voiceCall']> };
    case 'permission':
      return { ...base, permission: row.card as NonNullable<RoomViewMessage['permission']> };
    case 'grant-request':
      return { ...base, grantRequest: row.card as NonNullable<RoomViewMessage['grantRequest']> };
    case 'squire-approval':
      return {
        ...base,
        squireApproval: row.card as NonNullable<RoomViewMessage['squireApproval']>,
      };
    case 'computer-session':
      return {
        ...base,
        computerSession: row.card as NonNullable<RoomViewMessage['computerSession']>,
      };
    case 'connector-offer':
      return {
        ...base,
        connectorOffer: row.card as NonNullable<RoomViewMessage['connectorOffer']>,
      };
    case 'app-sign-in': {
      const card = row.card as NonNullable<RoomViewMessage['appSignIn']>;
      return {
        ...base,
        appSignIn: {
          appId: card.appId,
          appKey: card.appKey,
          name: card.name,
          ...(card.logo && /^https:\/\//i.test(card.logo) ? { logo: card.logo } : {}),
          ...(card.domain ? { domain: card.domain } : {}),
          ownerId: card.ownerId,
          agentId: card.agentId,
          status: card.status,
          ...(card.errorMessage ? { errorMessage: card.errorMessage } : {}),
          ...(card.continuation ? { continuation: card.continuation } : {}),
        },
      };
    }
    case 'agent-sign-in': {
      // The attempt id and source message stay server-side; no code or key is
      // ever stored. The link and device code are the owner's alone: anyone
      // else approving them would sign the agent in to their own account.
      const card = row.card as AgentSignInCardView;
      const owner = viewerId === card.ownerId;
      return {
        ...base,
        agentSignIn: {
          agentId: card.agentId,
          ownerId: card.ownerId,
          harness: card.harness,
          status: card.status,
          ...(card.kind ? { kind: card.kind } : {}),
          ...(owner && card.authorizeUrl ? { authorizeUrl: card.authorizeUrl } : {}),
          ...(owner && card.userCode ? { userCode: card.userCode } : {}),
          ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
          ...(card.provider ? { provider: card.provider } : {}),
          ...(card.errorMessage ? { errorMessage: card.errorMessage } : {}),
        },
      };
    }
    case 'repository-onboarding':
      return { ...base, onboarding: readRepositoryOnboardingCard(row.card) };
    case 'choice':
      return { ...base, choice: row.card as NonNullable<RoomViewMessage['choice']> };
    case 'agent-command':
      return { ...base, agentCommand: row.card as NonNullable<RoomViewMessage['agentCommand']> };
    case 'wallet-tx':
      return { ...base, walletTx: row.card as NonNullable<RoomViewMessage['walletTx']> };
    case 'wallet-insufficient':
      return {
        ...base,
        walletInsufficient: row.card as NonNullable<RoomViewMessage['walletInsufficient']>,
      };
    case 'wallet-delegation':
      return {
        ...base,
        walletDelegation: row.card as NonNullable<RoomViewMessage['walletDelegation']>,
      };
    case 'target-branch':
      return { ...base, targetBranch: row.card as NonNullable<RoomViewMessage['targetBranch']> };
    case 'github-event':
      return { ...base, githubEvent: row.card as NonNullable<RoomViewMessage['githubEvent']> };
    case 'daemon-fact':
      return { ...base, daemonFact: titledDaemonFact(row.card) };
    case 'corner':
      return { ...base, corner: row.card as NonNullable<RoomViewMessage['corner']> };
    default:
      return base;
  }
}


/** Canonical reactor identities, kept beside each bounded message row so every
 * Room/history projection can paint the same roster without a client lookup. */
export function reactionIdentitiesSql(messageAlias: string): string {
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',reactor.id,
      'kind',reactor.kind,
      'name',reactor.name,
      'handle',reactor.handle,
      'avatar',reactor.avatar,
      'face_id',reactor.face_id
    ) ORDER BY reactor.id)
    FROM identities reactor
    WHERE reactor.id IN (
      SELECT jsonb_array_elements_text(reaction.value)
      FROM jsonb_each(${messageAlias}.reactions) reaction
    )
  ),'[]'::jsonb)`;
}


/**
 * Every corner card is titled by its NAME. A card written before the name
 * existed carries only the objective, so its first three words stand in and
 * nothing in the app is ever drawn with a blank title (C89).
 */
export function titledDaemonFact(card: unknown): NonNullable<RoomViewMessage['daemonFact']> {
  const fact = card as NonNullable<RoomViewMessage['daemonFact']>;
  const title = cornerDisplayName(fact.name ?? fact.objective);
  return title ? { ...fact, name: title } : fact;
}


export function roomSchedule(row: RoomScheduleRow): RoomScheduleView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    roomId: row.room_id,
    agentId: row.agent_id,
    creatorId: row.creator_id,
    ...(row.paused_at ? { paused: true } : {}),
    title: scheduleDisplayTitle({ title: row.title, workflow: row.workflow_slug, prompt: row.message }),
    ...(row.max_runs != null ? { maxRuns: row.max_runs } : {}),
    cadence: row.cadence,
    message: row.message,
    nextRunAt: unix(row.next_run_at),
    createdAt: unix(row.created_at),
    ...(row.surface_parent_id && row.surface_name
      ? { corner: { id: row.room_id, name: row.surface_name } }
      : {}),
    ...(row.workflow_slug ? { workflowSlug: row.workflow_slug } : {}),
    runCount: row.run_count,
  };
}
