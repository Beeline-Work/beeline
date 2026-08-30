import { generateKeypair, signEvent } from '@beeline/nostr';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_DEFAULT_MAX_HOPS,
  AGENT_DELEGATION_HARD_MAX_HOPS,
  AGENT_DELEGATION_TAG,
  AGENT_MENTION_TAG,
  AGENT_MENTION_REPLY_TAG,
  AGENT_TO_AGENT_TURN_FUSE,
  AgentMentionTurnQueue,
  agentDelegationDedupe,
  agentDelegationMaxHops,
  agentDelegationTags,
  agentMentionTags,
  hasAgentMention,
  mentionedAgent,
  nextAgentMentionChain,
  parseAgentDelegation,
  parseAgentMention,
  roomAgentMention,
} from './agent-mention.js';

describe('signed agent mentions', () => {
  it('uses a dedicated transcript marker for replies dispatched by the host', () => {
    expect(AGENT_MENTION_REPLY_TAG).toBe('beeline-agent-mention-reply');
  });

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

describe('Room agent delegation', () => {
  it('finds markdown- and punctuation-delimited handles in text order', () => {
    const self = generateKeypair();
    const codex = generateKeypair();
    const roster = [{ handle: 'codex', pubkey: codex.publicKey, kind: 'agent' as const }];
    const oxReply =
      '...trying it again, fresh and clean: --- **@codex** Oi, dummy~! ... Per the host rules for this thread, my reply is allowed to @mention one peer agent ...';

    expect(roomAgentMention(oxReply, roster, self.publicKey)).toEqual({
      status: 'target',
      handle: 'codex',
      pubkey: codex.publicKey,
    });
    for (const text of ['(@codex)', '`@codex`', '@codex,', '**@codex**']) {
      expect(hasAgentMention(text)).toBe(true);
      expect(roomAgentMention(text, roster, self.publicKey)).toEqual({
        status: 'target',
        handle: 'codex',
        pubkey: codex.publicKey,
      });
      expect(
        mentionedAgent(text, [{ handle: 'codex', pubkey: codex.publicKey }], self.publicKey),
      ).toEqual({
        handle: 'codex',
        pubkey: codex.publicKey,
      });
    }
  });

  it('resolves one non-self agent in text order without treating people as targets', () => {
    const self = generateKeypair();
    const bee = generateKeypair();
    const ox = generateKeypair();
    const human = generateKeypair();
    const roster = [
      { handle: 'self', pubkey: self.publicKey, kind: 'agent' as const },
      { handle: 'milo', pubkey: human.publicKey, kind: 'human' as const },
      { handle: 'bee', pubkey: bee.publicKey, kind: 'agent' as const },
      { handle: 'ox', pubkey: ox.publicKey, kind: 'agent' as const },
    ];

    expect(roomAgentMention('Thanks @milo.', roster, self.publicKey)).toEqual({
      status: 'human',
      handle: 'milo',
    });
    expect(roomAgentMention('@self think aloud', roster, self.publicKey)).toEqual({
      status: 'self',
      handle: 'self',
    });
    expect(roomAgentMention('Ask @bee, @ox, and @self.', roster, self.publicKey)).toEqual({
      status: 'target',
      handle: 'bee',
      pubkey: bee.publicKey,
    });
    expect(roomAgentMention('Ask @missing.', roster, self.publicKey)).toEqual({ status: 'none' });
    expect(roomAgentMention('@mention me', roster, self.publicKey)).toEqual({ status: 'none' });
  });

  it('clamps the environment override to a small non-disableable bound', () => {
    expect(agentDelegationMaxHops(undefined)).toBe(AGENT_DELEGATION_DEFAULT_MAX_HOPS);
    expect(agentDelegationMaxHops('not-a-number')).toBe(AGENT_DELEGATION_DEFAULT_MAX_HOPS);
    expect(agentDelegationMaxHops('0')).toBe(1);
    expect(agentDelegationMaxHops('3')).toBe(3);
    expect(agentDelegationMaxHops('999')).toBe(AGENT_DELEGATION_HARD_MAX_HOPS);
  });

  it('round-trips a signed root-human envelope and rejects tampering or an excessive hop', () => {
    const human = generateKeypair();
    const from = generateKeypair();
    const to = generateKeypair();
    const rootRequestId = 'a'.repeat(64);
    const sourceEventId = rootRequestId;
    const content = '@bee produce the ten quotes and post them here.';
    const envelope = {
      rootRequestId,
      rootHumanPubkey: human.publicKey,
      fromAgentId: from.publicKey,
      toAgentId: to.publicKey,
      sourceEventId,
      hop: 1,
      dedupe: agentDelegationDedupe({
        rootRequestId,
        fromAgentId: from.publicKey,
        toAgentId: to.publicKey,
        text: content,
      }),
    };
    const event = signEvent(
      {
        pubkey: from.publicKey,
        created_at: 1,
        kind: 9,
        tags: [['h', 'room'], ['t', 'agent-message'], ...agentDelegationTags(envelope)],
        content,
      },
      from.secretKey,
    );

    expect(event.tags).toContainEqual(['t', AGENT_DELEGATION_TAG]);
    expect(parseAgentDelegation(event)).toEqual(envelope);
    expect(parseAgentDelegation({ ...event, content: `${content} changed` })).toBeUndefined();
    expect(parseAgentDelegation(event, 0)).toBeUndefined();
  });
});
