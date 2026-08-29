import { generateKeypair, signEvent } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MENTION_TAG,
  AGENT_TO_AGENT_TURN_FUSE,
  AgentMentionTurnQueue,
  agentMentionTags,
  mentionedAgent,
  nextAgentMentionChain,
  parseAgentMention,
} from './agent-mention.js';

describe('signed agent mentions', () => {
  it('resolves a stable same-roster agent id and round-trips signed metadata', () => {
    const from = generateKeypair();
    const to = generateKeypair();
    const source = 'a'.repeat(64);
    expect(
      mentionedAgent(
        'Please ask @bee_two to inspect this.',
        [{ handle: 'bee_two', pubkey: to.publicKey }],
        from.publicKey,
      ),
    ).toEqual({ handle: 'bee_two', pubkey: to.publicKey });
    const metadata = {
      workspaceId: 'workspace',
      roomId: 'room',
      cornerId: 'corner',
      fromAgentId: from.publicKey,
      toAgentId: to.publicKey,
      sourceTurnId: source,
      chainTurns: 1,
      writerAgentId: from.publicKey,
    };
    const event = signEvent(
      {
        pubkey: from.publicKey,
        created_at: 1,
        kind: 9,
        tags: [['h', 'corner'], ...agentMentionTags(metadata)],
        content: '@bee_two please inspect this.',
      },
      from.secretKey,
    );
    expect(parseAgentMention(event)).toEqual(metadata);
    expect(event.tags).toContainEqual(['t', AGENT_MENTION_TAG]);
  });

  it('refuses unsigned/tampered metadata and pauses at six consecutive agent turns', () => {
    const from = generateKeypair();
    const to = generateKeypair();
    const event = signEvent(
      {
        pubkey: from.publicKey,
        created_at: 1,
        kind: 9,
        tags: agentMentionTags({
          workspaceId: 'workspace',
          roomId: 'room',
          cornerId: 'corner',
          fromAgentId: from.publicKey,
          toAgentId: to.publicKey,
          sourceTurnId: 'b'.repeat(64),
          chainTurns: 1,
          writerAgentId: from.publicKey,
        }),
        content: '@bee',
      },
      from.secretKey,
    );
    expect(parseAgentMention({ ...event, content: 'tampered' })).toBeUndefined();
    let parent: ReturnType<typeof parseAgentMention> = {
      workspaceId: 'workspace',
      roomId: 'room',
      cornerId: 'corner',
      fromAgentId: from.publicKey,
      toAgentId: to.publicKey,
      sourceTurnId: 'b'.repeat(64),
      chainTurns: 5,
      writerAgentId: from.publicKey,
    };
    expect(nextAgentMentionChain(parent)).toEqual({
      status: 'pause',
      chainTurns: AGENT_TO_AGENT_TURN_FUSE,
    });
    expect(nextAgentMentionChain()).toEqual({ status: 'continue', chainTurns: 1 });
  });

  it('serializes each corner and permits only its existing writer lease', async () => {
    const queue = new AgentMentionTurnQueue();
    expect(queue.claimWriter('corner', 'agent-a')).toBe(true);
    expect(queue.claimWriter('corner', 'agent-b')).toBe(false);
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = queue.run('corner', async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      order.push('first-end');
    });
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    const second = queue.run('corner', async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
