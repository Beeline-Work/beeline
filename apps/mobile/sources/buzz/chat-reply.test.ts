import { describe, expect, it } from 'vitest';

import { chatReplyPreview, prepareChatReply, type ChatReplyTarget } from './chat-reply';

const agentTarget: ChatReplyTarget = {
  id: 'event-agent',
  authorLabel: 'Brisk Pilot',
  text: 'I found the failing check.',
  agentPubkey: 'agent-pubkey',
  agentHandle: 'brisk-pilot',
};

describe('chat replies', () => {
  it('prefixes an Agent reply and returns the pubkey used for explicit addressing', () => {
    expect(prepareChatReply('Please fix it', agentTarget)).toEqual({
      text: '@brisk-pilot Please fix it',
      replyToEventId: 'event-agent',
      mentionedAgentPubkey: 'agent-pubkey',
    });
  });

  it('does not duplicate an Agent prefix the person already typed', () => {
    expect(prepareChatReply('@BRISK-PILOT please fix it', agentTarget).text).toBe(
      '@BRISK-PILOT please fix it',
    );
    expect(prepareChatReply('@brisk-pilot, please fix it', agentTarget).text).toBe(
      '@brisk-pilot, please fix it',
    );
  });

  it('leaves a reply to a person unaddressed', () => {
    expect(
      prepareChatReply('Thanks', {
        id: 'event-person',
        authorLabel: 'Inez',
        text: 'Can you check this?',
      }),
    ).toEqual({ text: 'Thanks', replyToEventId: 'event-person' });
  });

  it('builds a compact fallback preview for attachment-only messages', () => {
    expect(chatReplyPreview(' First\n\nsecond ')).toBe('First second');
    expect(chatReplyPreview('', true)).toBe('Attachment');
  });
});
