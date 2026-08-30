import { createHash } from 'node:crypto';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';

export const AGENT_MENTION_TAG = 'beeline-agent-mention';
export const AGENT_MENTION_DISPATCH_TAG = 'beeline-agent-mention-dispatch';
export const AGENT_MENTION_REPLY_TAG = 'beeline-agent-mention-reply';
export const AGENT_MENTION_PAUSED_TAG = 'beeline-agent-chain-paused';
export const AGENT_TO_AGENT_TURN_FUSE = 6;
export const AGENT_DELEGATION_TAG = 'buzz-agent-delegation';
export const AGENT_DELEGATION_DEFAULT_MAX_HOPS = 4;
export const AGENT_DELEGATION_HARD_MAX_HOPS = 8;

const PUBKEY = /^[0-9a-f]{64}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;
const AGENT_MENTION_HANDLE =
  /(?:^|[\s\p{P}\p{S}])@([\p{L}\p{N}_-](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_-])?)/gu;

export interface AgentMentionMetadata {
  workspaceId: string;
  roomId: string;
  cornerId: string;
  fromAgentId: string;
  toAgentId: string;
  sourceTurnId: string;
  chainTurns: number;
  writerAgentId: string;
}

export interface AgentDelegationEnvelope {
  rootRequestId: string;
  rootHumanPubkey: string;
  fromAgentId: string;
  toAgentId: string;
  sourceEventId: string;
  hop: number;
  dedupe: string;
}

export type RoomAgentMentionResolution =
  | { status: 'none' }
  | { status: 'self'; handle: string }
  | { status: 'human'; handle: string }
  | { status: 'unknown'; handle: string }
  | { status: 'target'; handle: string; pubkey: string };

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function agentDelegationMaxHops(
  raw: string | undefined = process.env.BUZZY_BODY_AGENT_DELEGATION_MAX_HOPS,
): number {
  const configured = Number(raw);
  if (!Number.isInteger(configured)) return AGENT_DELEGATION_DEFAULT_MAX_HOPS;
  return Math.max(1, Math.min(AGENT_DELEGATION_HARD_MAX_HOPS, configured));
}

function mentionHandles(text: string): string[] {
  return [
    ...text.normalize('NFKC').matchAll(AGENT_MENTION_HANDLE),
  ].map((match) => match[1]!.toLowerCase());
}

export function hasAgentMention(text: string): boolean {
  return mentionHandles(text).length > 0;
}

/** Resolve at most one peer. Multiple mentions are visible context, never fan-out. */
export function roomAgentMention(
  text: string,
  roster: readonly { handle: string; pubkey: string; kind?: 'agent' | 'human' }[],
  selfPubkey: string,
): RoomAgentMentionResolution {
  const byHandle = new Map(
    roster.map((entry) => [entry.handle.replace(/^@/, '').normalize('NFKC').toLowerCase(), entry]),
  );
  const handles = mentionHandles(text);
  if (!handles.length) return { status: 'none' };
  let firstNonTarget: RoomAgentMentionResolution | undefined;
  for (const handle of handles) {
    const found = byHandle.get(handle);
    if (!found) continue;
    if (found.pubkey === selfPubkey) {
      firstNonTarget ??= { status: 'self', handle };
      continue;
    }
    if (found.kind === 'human') {
      firstNonTarget ??= { status: 'human', handle };
      continue;
    }
    return { status: 'target', handle, pubkey: found.pubkey };
  }
  return firstNonTarget ?? { status: 'none' };
}

export function agentDelegationDedupe(input: {
  rootRequestId: string;
  fromAgentId: string;
  toAgentId: string;
  text: string;
}): string {
  const normalizedText = input.text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256')
    .update(
      [input.rootRequestId, input.fromAgentId, input.toAgentId, normalizedText].join('\u0000'),
    )
    .digest('hex');
}

export function agentDelegationTags(envelope: AgentDelegationEnvelope): string[][] {
  return [
    ['t', AGENT_DELEGATION_TAG],
    ['root-request', envelope.rootRequestId],
    ['root-human', envelope.rootHumanPubkey],
    ['from-agent', envelope.fromAgentId],
    ['to-agent', envelope.toAgentId],
    ['source-event', envelope.sourceEventId],
    ['hop', String(envelope.hop)],
    ['dedupe', envelope.dedupe],
    ['p', envelope.toAgentId],
  ];
}

export function parseAgentDelegation(
  event: NostrEvent,
  maxHops = agentDelegationMaxHops(),
): AgentDelegationEnvelope | undefined {
  if (
    !verifyEvent(event) ||
    event.kind !== 9 ||
    !event.tags.some((tag) => tag[0] === 't' && tag[1] === AGENT_DELEGATION_TAG)
  ) {
    return undefined;
  }
  const rootRequestId = tagValue(event, 'root-request');
  const rootHumanPubkey = tagValue(event, 'root-human');
  const fromAgentId = tagValue(event, 'from-agent');
  const toAgentId = tagValue(event, 'to-agent');
  const sourceEventId = tagValue(event, 'source-event');
  const dedupe = tagValue(event, 'dedupe');
  const hop = Number(tagValue(event, 'hop'));
  if (
    !EVENT_ID.test(rootRequestId ?? '') ||
    !PUBKEY.test(rootHumanPubkey ?? '') ||
    !PUBKEY.test(fromAgentId ?? '') ||
    !PUBKEY.test(toAgentId ?? '') ||
    !EVENT_ID.test(sourceEventId ?? '') ||
    !EVENT_ID.test(dedupe ?? '') ||
    event.pubkey !== fromAgentId ||
    fromAgentId === toAgentId ||
    event.tags.filter((tag) => tag[0] === 'p' && tag[1] === toAgentId).length !== 1 ||
    !Number.isSafeInteger(hop) ||
    hop < 1 ||
    hop > maxHops
  ) {
    return undefined;
  }
  const envelope = {
    rootRequestId: rootRequestId!,
    rootHumanPubkey: rootHumanPubkey!,
    fromAgentId: fromAgentId!,
    toAgentId: toAgentId!,
    sourceEventId: sourceEventId!,
    hop,
    dedupe: dedupe!,
  };
  return agentDelegationDedupe({
    rootRequestId: envelope.rootRequestId,
    fromAgentId: envelope.fromAgentId,
    toAgentId: envelope.toAgentId,
    text: event.content,
  }) === envelope.dedupe
    ? envelope
    : undefined;
}

export function mentionedAgent(
  text: string,
  roster: readonly { handle: string; pubkey: string }[],
  selfPubkey: string,
): { handle: string; pubkey: string } | undefined {
  const byHandle = new Map(
    roster.map((entry) => [entry.handle.replace(/^@/, '').normalize('NFKC').toLowerCase(), entry]),
  );
  for (const handle of mentionHandles(text)) {
    const found = byHandle.get(handle);
    if (found && found.pubkey !== selfPubkey) return found;
  }
  return undefined;
}

export function agentMentionTags(
  metadata: AgentMentionMetadata,
  marker: typeof AGENT_MENTION_TAG | typeof AGENT_MENTION_DISPATCH_TAG = AGENT_MENTION_TAG,
): string[][] {
  return [
    ['t', marker],
    ['workspace', metadata.workspaceId],
    ['room', metadata.roomId],
    ['corner', metadata.cornerId],
    ['from-agent', metadata.fromAgentId],
    ['to-agent', metadata.toAgentId],
    ['source-turn', metadata.sourceTurnId],
    ['chain-turns', String(metadata.chainTurns)],
    ['writer-agent', metadata.writerAgentId],
    ['p', metadata.toAgentId],
  ];
}

export function parseAgentMention(
  event: NostrEvent,
  marker: typeof AGENT_MENTION_TAG | typeof AGENT_MENTION_DISPATCH_TAG = AGENT_MENTION_TAG,
): AgentMentionMetadata | undefined {
  if (!verifyEvent(event) || !event.tags.some((tag) => tag[0] === 't' && tag[1] === marker)) {
    return undefined;
  }
  const workspaceId = tagValue(event, 'workspace');
  const roomId = tagValue(event, 'room');
  const cornerId = tagValue(event, 'corner');
  const fromAgentId = tagValue(event, 'from-agent');
  const toAgentId = tagValue(event, 'to-agent');
  const sourceTurnId = tagValue(event, 'source-turn');
  const writerAgentId = tagValue(event, 'writer-agent');
  const chainTurns = Number(tagValue(event, 'chain-turns'));
  if (
    !workspaceId ||
    !roomId ||
    !cornerId ||
    !PUBKEY.test(fromAgentId ?? '') ||
    !PUBKEY.test(toAgentId ?? '') ||
    !EVENT_ID.test(sourceTurnId ?? '') ||
    !PUBKEY.test(writerAgentId ?? '') ||
    event.pubkey !== fromAgentId ||
    fromAgentId === toAgentId ||
    !event.tags.some((tag) => tag[0] === 'p' && tag[1] === toAgentId) ||
    !Number.isSafeInteger(chainTurns) ||
    chainTurns < 1 ||
    chainTurns > AGENT_TO_AGENT_TURN_FUSE
  ) {
    return undefined;
  }
  return {
    workspaceId,
    roomId,
    cornerId,
    fromAgentId: fromAgentId!,
    toAgentId: toAgentId!,
    sourceTurnId: sourceTurnId!,
    chainTurns,
    writerAgentId: writerAgentId!,
  };
}

export function nextAgentMentionChain(
  parent?: AgentMentionMetadata,
):
  | { status: 'continue'; chainTurns: number }
  | { status: 'pause'; chainTurns: typeof AGENT_TO_AGENT_TURN_FUSE } {
  const chainTurns = (parent?.chainTurns ?? 0) + 1;
  return chainTurns >= AGENT_TO_AGENT_TURN_FUSE
    ? { status: 'pause', chainTurns: AGENT_TO_AGENT_TURN_FUSE }
    : { status: 'continue', chainTurns };
}

/**
 * Per-corner serialization and writer ownership. Mention turns are queued in
 * transcript order; a second agent can converse but cannot silently take the
 * corner's write lease.
 */
export class AgentMentionTurnQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly writers = new Map<string, string>();

  claimWriter(cornerId: string, writerAgentId: string): boolean {
    const current = this.writers.get(cornerId);
    if (current && current !== writerAgentId) return false;
    this.writers.set(cornerId, writerAgentId);
    return true;
  }

  run<T>(cornerId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(cornerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.tails.set(cornerId, tail);
    return prior
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        release();
        if (this.tails.get(cornerId) === tail) this.tails.delete(cornerId);
      });
  }

  release(cornerId: string): void {
    this.writers.delete(cornerId);
    this.tails.delete(cornerId);
  }
}
