/**
 * Activity projection: subscribe to the edit session's ACP `session/update`
 * stream and project tool_call/message chunks as channel events every member
 * can see (kind:9 + #t=agent-activity tag).
 *
 * This is what makes "watch the agent work, together" real — the body bridges
 * the stdio-local ACP stream into the relay channel so all members receive live
 * agent activity.
 */
import { randomUUID } from 'node:crypto';
import type { AcpClient, SessionUpdate } from './acp.js';
import type { Identity } from '@beeline/gate';
import { publishEvent } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  AGENT_PRESENCE_HEARTBEAT_MS,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
  buildAttachmentTags,
  type AgentPresenceStatus,
  type AttachmentReference,
} from '@beeline/buzz-client';
import { sanitizeActivityUpdate } from './attachments.js';

export const ACTIVITY_TAG = 'agent-activity';
export const AGENT_MESSAGE_TAG = 'agent-message';
export const AGENT_TURN_TAG = 'agent-turn';

const CODEX_HARNESS_NOTICE =
  /^(?:⚠(?:️)?\s*)?(?:warning|notice):\s*(?:skill|tool|plugin) descriptions?\b.*\b(?:context budget|budget limit)\b/i;
const CODEX_HARNESS_NOTICE_CONTINUATION =
  /^(?:codex can still (?:see|access|read)|(?:use|open|read)\s+\S*skill\.md\b)/i;

/** Remove only the known leading Codex startup warning, never mid-reply text. */
export function stripAgentReplyPreamble(message: string): string {
  const lines = message.split(/\r?\n/);
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  if (firstContent < 0 || !CODEX_HARNESS_NOTICE.test(lines[firstContent]!.trim())) {
    return message;
  }
  let replyStart = firstContent + 1;
  while (
    replyStart < lines.length &&
    (!lines[replyStart]!.trim() ||
      CODEX_HARNESS_NOTICE_CONTINUATION.test(lines[replyStart]!.trim()) ||
      CODEX_HARNESS_NOTICE.test(lines[replyStart]!.trim()))
  ) {
    replyStart++;
  }
  return lines.slice(replyStart).join('\n');
}

/** Batched activity to emit as a single channel event. */
export interface ActivityBatch {
  sessionId: string;
  channelId: string;
  events: SessionUpdate[];
}

/**
 * Project ACP session/update notifications into channel events.
 * Returns an unsubscribe function.
 */
export function projectActivity(
  client: AcpClient,
  channelId: string,
  channelOwner: Identity,
  sessionId: string,
): () => void {
  let pending: SessionUpdate[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const events = pending;
    pending = [];
    if (events.length)
      void emitActivityEvent(channelId, channelOwner, { sessionId, channelId, events });
  };
  const onUpdate = (u: SessionUpdate) => {
    if (u.sessionId !== sessionId) return;
    // Assistant prose is published once, as a first-class channel message,
    // after sessionPrompt completes. Keep the activity stream for thought/tool
    // telemetry so conversation copy cannot be duplicated or lost in a batch.
    if (u.update.sessionUpdate === 'agent_message_chunk') return;
    pending.push({ ...u, update: sanitizeActivityUpdate(u.update) });
    // One paired identity can serve several Rooms. A five-second batch keeps
    // shared live visibility while staying below per-pubkey relay quotas under
    // concurrent tool-call bursts.
    timer ??= setTimeout(flush, 5_000);
  };

  client.on('session/update', onUpdate);
  return () => {
    client.off('session/update', onUpdate);
    flush();
  };
}

/** Publish a completed assistant turn as durable conversation, not telemetry. */
export async function postAgentMessage(
  channelId: string,
  owner: Identity,
  message: string,
  replyTo?: string,
  attachments: readonly AttachmentReference[] = [],
  extraTags: readonly string[][] = [],
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [
        ['h', channelId],
        ['t', AGENT_MESSAGE_TAG],
        ...(replyTo ? [['e', replyTo, '', 'reply']] : []),
        ...buildAttachmentTags(attachments),
        ...extraTags,
      ],
      content: message,
    },
    owner.secretKey,
  );

  await publishEvent(event, owner);
}

/** Publish the read-only Room turn lifecycle used by the thinking indicator. */
export function postAgentTurnStatus(
  channelId: string,
  owner: Identity,
  requestId: string,
  sessionId: string,
  status: 'working' | 'complete' | 'failed',
  generationId?: string,
): Promise<void> {
  const message =
    status === 'working'
      ? 'Agent is thinking…'
      : status === 'complete'
        ? 'Agent reply complete.'
        : 'Agent reply stopped.';
  return postControlMessage(channelId, owner, message, [
    ['t', AGENT_TURN_TAG],
    ['request', requestId],
    ['session', sessionId],
    ['agent', owner.publicKey],
    ['mode', 'readonly'],
    ['status', status],
    ...(generationId ? [['generation', generationId]] : []),
  ]);
}

/** Publish one signed, replaceable Room-scoped daemon presence marker. */
export async function postAgentPresence(
  channelId: string,
  owner: Identity,
  status: AgentPresenceStatus,
  createdAt = Math.floor(Date.now() / 1_000),
  generationId?: string,
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: createdAt,
      kind: KIND_AGENT_PRESENCE,
      tags: [
        ['d', `agent-presence:${channelId}`],
        ['h', channelId],
        ['t', TAG_AGENT_PRESENCE],
        ['agent', owner.publicKey],
        ['status', status],
        ...(generationId ? [['generation', generationId]] : []),
      ],
      content: status,
    },
    owner.secretKey,
  );
  await publishEvent(event, owner);
}

/**
 * Start a low-rate heartbeat. Publishes immediately and serializes refreshes so
 * a slow relay cannot create overlapping requests. The returned stop function
 * emits an offline marker after any in-flight heartbeat settles.
 */
export function startAgentPresence(
  channelId: string,
  owner: Identity,
  intervalMs = AGENT_PRESENCE_HEARTBEAT_MS,
): (() => Promise<void>) & { generationId: string } {
  let stopped = false;
  let lastCreatedAt = 0;
  let chain = Promise.resolve();
  const generationId = randomUUID();
  const enqueue = (status: AgentPresenceStatus) => {
    const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastCreatedAt + 1);
    lastCreatedAt = createdAt;
    chain = chain
      .then(() => postAgentPresence(channelId, owner, status, createdAt, generationId))
      .catch((error) => console.error(`[body] agent presence ${status} failed:`, error));
    return chain;
  };

  void enqueue('online');
  const timer = setInterval(() => {
    if (!stopped) void enqueue('online');
  }, intervalMs);
  timer.unref?.();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await chain;
    const createdAt = Math.max(Math.floor(Date.now() / 1_000), lastCreatedAt + 1);
    await postAgentPresence(channelId, owner, 'offline', createdAt, generationId).catch((error) =>
      console.error('[body] agent presence offline failed:', error),
    );
  };
  return Object.assign(stop, { generationId });
}

/** Emit an ordered batch of session updates as one kind:9 channel event. */
async function emitActivityEvent(
  channelId: string,
  owner: Identity,
  batch: ActivityBatch,
): Promise<void> {
  try {
    const content = JSON.stringify({
      sessionId: batch.sessionId,
      update: {
        sessionUpdate: 'activity_batch',
        updates: batch.events.map((event) => event.update),
      },
      projected: true,
    });

    const event: NostrEvent = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', channelId],
          ['t', ACTIVITY_TAG],
          ['session', batch.sessionId],
        ],
        content,
      },
      owner.secretKey,
    );

    await publishEvent(event, owner);
  } catch (err) {
    // Log but don't crash the body — activity projection is best-effort.
    console.error('[body] activity projection error:', err);
  }
}

/**
 * Post a control message to a channel (kind:9 with specific tag).
 * Used for: "subchannel opened", "session started", "session archived", etc.
 */
export async function postControlMessage(
  channelId: string,
  owner: Identity,
  msg: string,
  extraTags: string[][] = [],
): Promise<void> {
  const event: NostrEvent = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [['h', channelId], ['t', 'body-control'], ...extraTags],
      content: msg,
    },
    owner.secretKey,
  );

  await publishEvent(event, owner);
}
