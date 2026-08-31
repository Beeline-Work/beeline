import type { Identity } from '@beeline/gate';
import { publishEvent } from '@beeline/gate';
import {
  AGENT_PRESENCE_HEARTBEAT_MS,
  agentPresenceKey,
  buildAttachmentTags,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
  type AgentPresenceStatus,
  type AttachmentReference,
} from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';

/**
 * The only durable daemon-transcript publication boundary.
 *
 * A kind names the factual reason the daemon is allowed to write. Keeping the
 * vocabulary closed prevents a convenient low-level kind:9 helper from
 * turning transport state back into conversational agent prose.
 */
export type LifecyclePublicationKind =
  | 'model-output'
  | 'permission-request'
  | 'permission-status'
  | 'agent-prompt-refused'
  | 'target-branch-proposal'
  | 'mention-budget-limit'
  | 'mention-delivery'
  | 'corner-created'
  | 'corner-open-fact'
  | 'archived'
  | 'turn-receipt'
  | 'corner-session-live'
  | 'pull-request-fact'
  | 'checks-failing-fact'
  | 'completion-nudge'
  | 'branch-ended'
  | 'rearmed-failure';

export interface AgentPresenceAccessSeed {
  policy: 'everyone' | 'creator' | 'allowlist';
  allowlist?: readonly string[];
}

interface LifecycleMessageInput {
  kind: LifecyclePublicationKind;
  channelId: string;
  owner: Identity;
  content: string;
  tags?: readonly string[][];
  replyTo?: string;
  replyRootId?: string;
  attachments?: readonly AttachmentReference[];
  createdAt?: number;
}

export function buildLifecycleMessage(input: LifecycleMessageInput): NostrEvent {
  const trimmed = input.content.trim();
  if (trimmed) {
    try {
      JSON.parse(trimmed);
      throw new Error('refused JSON content in daemon-authored kind:9 publication');
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'refused JSON content in daemon-authored kind:9 publication'
      ) {
        throw error;
      }
    }
  }
  const modelOutput = input.kind === 'model-output';
  const daemonFact =
    input.kind === 'pull-request-fact' ||
    input.kind === 'checks-failing-fact' ||
    input.kind === 'completion-nudge' ||
    input.kind === 'branch-ended' ||
    input.kind === 'corner-open-fact';
  const marker = modelOutput ? 'agent-message' : daemonFact ? 'daemon-fact' : 'body-control';
  return signEvent(
    {
      pubkey: input.owner.publicKey,
      created_at: input.createdAt ?? Math.floor(Date.now() / 1_000),
      kind: 9,
      tags: [
        ['h', input.channelId],
        ['t', marker],
        ...(input.replyTo && input.replyRootId && input.replyRootId !== input.replyTo
          ? [['e', input.replyRootId, '', 'root']]
          : []),
        ...(input.replyTo ? [['e', input.replyTo, '', 'reply']] : []),
        ...buildAttachmentTags(input.attachments ?? []),
        ...(input.tags ?? []),
      ],
      content: input.content,
    },
    input.owner.secretKey,
  );
}

export async function publishLifecycleMessage(input: LifecycleMessageInput): Promise<NostrEvent> {
  const event = buildLifecycleMessage(input);
  await publishEvent(event, input.owner);
  return event;
}

type ControlPublicationKind = Exclude<
  LifecyclePublicationKind,
  'model-output'
>;

function inferredControlKind(tags: readonly string[][]): ControlPublicationKind {
  const markers = new Set(tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]));
  const status = tags.find((tag) => tag[0] === 'status')?.[1];
  if (markers.has('buzz-write-permission-request')) return 'permission-request';
  if (markers.has('buzz-agent-prompt-refused')) return 'agent-prompt-refused';
  if (markers.has('buzz-target-branch-proposal')) return 'target-branch-proposal';
  if (markers.has('buzz-agent-mention-paused')) return 'mention-budget-limit';
  if (markers.has('buzz-agent-mention-dispatch')) return 'mention-delivery';
  if (markers.has('agent-turn')) return 'turn-receipt';
  if (markers.has('corner-session')) return 'corner-session-live';
  if (status === 'archived' || status === 'closed') return 'archived';
  if (status === 'failed') return 'rearmed-failure';
  if (tags.some((tag) => tag[0] === 'subchannel')) return 'corner-created';
  throw new Error('refused unclassified daemon transcript publication');
}

export function buildControlMessage(
  channelId: string,
  owner: Identity,
  content: string,
  tags?: readonly string[][],
): NostrEvent;
export function buildControlMessage(
  kind: ControlPublicationKind,
  channelId: string,
  owner: Identity,
  content: string,
  tags?: readonly string[][],
): NostrEvent;
export function buildControlMessage(
  kindOrChannelId: ControlPublicationKind | string,
  channelIdOrOwner: string | Identity,
  ownerOrContent: Identity | string,
  contentOrTags?: string | readonly string[][],
  maybeTags: readonly string[][] = [],
): NostrEvent {
  const explicit = typeof channelIdOrOwner === 'string';
  const channelId = explicit ? channelIdOrOwner : kindOrChannelId;
  const owner = (explicit ? ownerOrContent : channelIdOrOwner) as Identity;
  const content = (explicit ? contentOrTags : ownerOrContent) as string;
  const tags = (explicit ? maybeTags : (contentOrTags ?? [])) as readonly string[][];
  const kind = explicit ? (kindOrChannelId as ControlPublicationKind) : inferredControlKind(tags);
  return buildLifecycleMessage({ kind, channelId, owner, content, tags });
}

export async function postControlMessage(
  channelId: string,
  owner: Identity,
  content: string,
  tags?: readonly string[][],
): Promise<void>;
export async function postControlMessage(
  kind: ControlPublicationKind,
  channelId: string,
  owner: Identity,
  content: string,
  tags?: readonly string[][],
): Promise<void>;
export async function postControlMessage(
  kindOrChannelId: ControlPublicationKind | string,
  channelIdOrOwner: string | Identity,
  ownerOrContent: Identity | string,
  contentOrTags?: string | readonly string[][],
  maybeTags: readonly string[][] = [],
): Promise<void> {
  const explicit = typeof channelIdOrOwner === 'string';
  const channelId = explicit ? channelIdOrOwner : kindOrChannelId;
  const owner = (explicit ? ownerOrContent : channelIdOrOwner) as Identity;
  const content = (explicit ? contentOrTags : ownerOrContent) as string;
  const tags = (explicit ? maybeTags : (contentOrTags ?? [])) as readonly string[][];
  const kind = explicit ? (kindOrChannelId as ControlPublicationKind) : inferredControlKind(tags);
  const event = buildLifecycleMessage({ kind, channelId, owner, content, tags });
  await publishEvent(event, owner);
}

export function buildAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
  replyRootId?: string,
  createdAt = Math.floor(Date.now() / 1_000),
): NostrEvent {
  return buildLifecycleMessage({
    kind: 'model-output',
    channelId,
    owner,
    content: message,
    replyTo,
    attachments,
    tags: extraTags,
    replyRootId,
    createdAt,
  });
}

export async function publishAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
  replyRootId?: string,
  createdAt?: number,
): Promise<void> {
  await publishLifecycleMessage({
    kind: 'model-output',
    channelId,
    owner,
    content: message,
    replyTo,
    attachments,
    tags: extraTags,
    replyRootId,
    createdAt,
  });
}

/** Publish one signed, replaceable Room-scoped daemon presence marker. */
export async function publishAgentPresence(
  channelId: string,
  owner: Identity,
  status: AgentPresenceStatus,
  createdAt = Math.floor(Date.now() / 1_000),
  generationId?: string,
  accessSeed?: AgentPresenceAccessSeed,
): Promise<void> {
  const event = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: KIND_AGENT_PRESENCE,
      tags: [
        ['d', agentPresenceKey(channelId)],
        ['h', channelId],
        ['t', TAG_AGENT_PRESENCE],
        ['agent', owner.publicKey],
        ['status', status],
        ['capability', 'factory-permissions-v1'],
        ['capability', 'agent-mention-v1'],
        ...(generationId ? [['generation', generationId]] : []),
        ...(accessSeed ? [['access-policy', accessSeed.policy]] : []),
        ...(accessSeed?.allowlist?.map((pubkey) => ['access-allow', pubkey]) ?? []),
      ],
      content: status,
    },
    owner.secretKey,
  );
  await publishEvent(event, owner);
}

/** Terminal presence replacement used only when a corner is archived. */
export async function retractAgentPresence(
  cornerId: string,
  scopeChannelId: string,
  owner: Identity,
  createdAt = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const event = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: KIND_AGENT_PRESENCE,
      tags: [
        ['d', agentPresenceKey(cornerId)],
        ['h', scopeChannelId],
        ['t', TAG_AGENT_PRESENCE],
        ['agent', owner.publicKey],
        ['status', 'offline'],
        ['terminal', 'closed'],
        ['corner', cornerId],
      ],
      content: 'offline',
    },
    owner.secretKey,
  );
  await publishEvent(event, owner);
}

export { AGENT_PRESENCE_HEARTBEAT_MS };
