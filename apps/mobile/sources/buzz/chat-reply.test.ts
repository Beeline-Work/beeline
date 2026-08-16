import { describe, expect, it } from 'vitest';

import { chatReplyExcerpt, prepareChatReply, type ChatReplyTarget } from './chat-reply';

const agentReply: ChatReplyTarget = {
  messageId: 'agent-message',
  authorName: 'BeeBee',
  authorHandle: 'beebee',
  excerpt: 'I can take a look.',
  agentPubkey: 'a'.repeat(64),
};

describe('chat replies', () => {
  it('prefixes the original author and preserves an Agent target for the signed p-tag', () => {
    expect(prepareChatReply('please do', agentReply)).toEqual({
      text: '@beebee please do',
      agentPubkey: 'a'.repeat(64),
    });
  });

  it('does not duplicate a mention the person already typed', () => {
    expect(prepareChatReply('@BeeBee, please do', agentReply)).toEqual({
      text: '@BeeBee, please do',
      agentPubkey: 'a'.repeat(64),
    });
  });

  it('prefixes a person reply without turning it into an Agent address', () => {
    expect(
      prepareChatReply('thanks', {
        ...agentReply,
        authorName: 'Ada',
        authorHandle: '@ada',
        agentPubkey: undefined,
      }),
    ).toEqual({ text: '@ada thanks' });
  });

  it('leaves ordinary messages unchanged and compacts reply excerpts', () => {
    expect(prepareChatReply('  hello  ', null)).toEqual({ text: 'hello' });
    expect(chatReplyExcerpt('  first\n\nsecond   third  ', 18)).toBe('first second third');
    expect(chatReplyExcerpt('one two three four', 12)).toBe('one two thr…');
  });
});
