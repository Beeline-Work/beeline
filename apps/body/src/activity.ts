/**
 * Activity projection: subscribe to the edit session's ACP `session/update`
 * stream and project tool_call/message chunks as channel events every member
 * can see (kind:9 + #t=agent-activity tag).
 *
 * This is what makes "watch the agent work, together" real — the body bridges
 * the stdio-local ACP stream into the relay channel so all members receive live
 * agent activity.
 */
import type { AcpClient, SessionUpdate } from './acp.js';
import type { Identity } from '@beeline/gate';
import { publishEvent } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';

export const ACTIVITY_TAG = 'agent-activity';
export const AGENT_MESSAGE_TAG = 'agent-message';

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
    if (events.length) void emitActivityEvent(channelId, channelOwner, { sessionId, channelId, events });
  };
  const onUpdate = (u: SessionUpdate) => {
    if (u.sessionId !== sessionId) return;
    // Assistant prose is published once, as a first-class channel message,
    // after sessionPrompt completes. Keep the activity stream for thought/tool
    // telemetry so conversation copy cannot be duplicated or lost in a batch.
    if (u.update.sessionUpdate === 'agent_message_chunk') return;
    pending.push(u);
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
      ],
      content: message,
    },
    owner.secretKey,
  );

  await publishEvent(event, owner);
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
      tags: [
        ['h', channelId],
        ['t', 'body-control'],
        ...extraTags,
      ],
      content: msg,
    },
    owner.secretKey,
  );

  await publishEvent(event, owner);
}
