import { describe, expect, it } from 'vitest';
import { shouldShowReplyReference } from './reply-reference';

describe('shouldShowReplyReference', () => {
  it('does not invent a reference for a message without a reply target', () => {
    expect(
      shouldShowReplyReference({
        speaksAsAgent: true,
        immediatelyPrecedingMessage: { id: 'request-event' },
      }),
    ).toBe(false);
  });

  it('keeps an adjacent agent request and reply visually quiet', () => {
    expect(
      shouldShowReplyReference({
        replyToId: 'request-event',
        speaksAsAgent: true,
        immediatelyPrecedingMessage: { id: 'request-event' },
      }),
    ).toBe(false);
  });

  it('recognizes the relay id of an adjacent reconciled message', () => {
    expect(
      shouldShowReplyReference({
        replyToId: 'request-relay-event',
        speaksAsAgent: true,
        immediatelyPrecedingMessage: {
          id: 'stable-display-id',
          relayId: 'request-relay-event',
        },
      }),
    ).toBe(false);
  });

  it('shows a queued agent reply that targets an earlier visible message', () => {
    expect(
      shouldShowReplyReference({
        replyToId: 'earlier-request',
        speaksAsAgent: true,
        immediatelyPrecedingMessage: { id: 'newer-message' },
      }),
    ).toBe(true);
  });

  it('keeps reply references for human-authored replies', () => {
    expect(
      shouldShowReplyReference({
        replyToId: 'request-event',
        speaksAsAgent: false,
        immediatelyPrecedingMessage: { id: 'request-event' },
      }),
    ).toBe(true);
  });
});
