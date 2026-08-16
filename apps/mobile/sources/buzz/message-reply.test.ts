import { describe, expect, it } from 'vitest';

import { replyMessageText, type MessageReplyTarget } from './message-reply';

const personTarget: MessageReplyTarget = {
  messageId: 'person-message',
  authorName: 'Mira',
  authorPubkey: 'person',
  isAgent: false,
  preview: 'A human note',
};

const agentTarget: MessageReplyTarget = {
  messageId: 'agent-message',
  authorName: 'Brisk Pilot',
  authorPubkey: 'agent',
  isAgent: true,
  preview: 'An agent answer',
};

describe('message replies', () => {
  it('keeps a person reply body unchanged', () => {
    expect(replyMessageText('  I agree  ', personTarget)).toBe('I agree');
  });

  it('addresses an Agent at the beginning of a reply', () => {
    expect(replyMessageText('Can you expand on that?', agentTarget)).toBe(
      '@Brisk Pilot Can you expand on that?',
    );
  });

  it('does not duplicate an Agent mention already placed first', () => {
    expect(replyMessageText('@brisk pilot please continue', agentTarget)).toBe(
      '@brisk pilot please continue',
    );
  });

  it('does not mistake a longer handle for the replied-to Agent', () => {
    expect(replyMessageText('@Brisk Pilotfish check this', agentTarget)).toBe(
      '@Brisk Pilot @Brisk Pilotfish check this',
    );
  });
});
