import { verifyEvent, type NostrEvent } from '@beeline/nostr';

export const AGENT_MENTION_TAG = 'beeline-agent-mention';
export const AGENT_MENTION_DISPATCH_TAG = 'beeline-agent-mention-dispatch';
export const AGENT_MENTION_REPLY_TAG = 'beeline-agent-mention-reply';
export const AGENT_MENTION_PAUSED_TAG = 'beeline-agent-chain-paused';
export const AGENT_TO_AGENT_TURN_FUSE = 6;

const PUBKEY = /^[0-9a-f]{64}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;

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

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function mentionedAgent(
  text: string,
  roster: readonly { handle: string; pubkey: string }[],
  selfPubkey: string,
): { handle: string; pubkey: string } | undefined {
  const byHandle = new Map(
    roster.map((entry) => [entry.handle.replace(/^@/, '').normalize('NFKC').toLowerCase(), entry]),
  );
  for (const match of text.normalize('NFKC').matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)/gu)) {
    const found = byHandle.get(match[1]!.toLowerCase());
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
