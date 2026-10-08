import { describe, expect, it } from 'vitest';

import {
  activityMessageReplyTarget,
  activityReplyParent,
  agentActivityReplyExcerpt,
  prepareMessageReply,
} from './message-reply';

const sol = {
  messageId: 'agent-final-message-id',
  authorName: 'Sol',
  authorHandle: 'sol',
  authorPubkey: 'sol-agent-id',
  isAgent: true,
  preview: 'The final answer',
};

describe('message replies', () => {
  it('sends the composer text as typed and never adds a hidden tag', () => {
    expect(prepareMessageReply('  @sol Can you expand on that?  ', sol)).toEqual({
      text: '@sol Can you expand on that?',
      agentPubkey: 'sol-agent-id',
    });
    expect(prepareMessageReply('  Thanks  ', { ...sol, isAgent: false })).toEqual({
      text: 'Thanks',
    });
  });

  it('does not address the agent once its prefilled handle is deleted', () => {
    expect(prepareMessageReply('Thanks', sol)).toEqual({ text: 'Thanks' });
    expect(prepareMessageReply('@solo Thanks', sol)).toEqual({ text: '@solo Thanks' });
  });

  it('keeps a corner agent reply bound to its parent and exact agent', () => {
    const reference = {
      channelId: 'corner-id',
      eventId: 'agent-final-message-id',
      rootId: 'agent-final-message-id',
    };

    expect(
      prepareMessageReply('  @sol Can you clarify?  ', {
        messageId: 'agent-final-message-id',
        authorName: 'Sol',
        authorHandle: 'sol',
        authorPubkey: 'sol-agent-id',
        isAgent: true,
        preview: 'The final answer',
        reference,
      }),
    ).toEqual({
      text: '@sol Can you clarify?',
      reference,
      agentPubkey: 'sol-agent-id',
    });
  });

  it('keeps activity out of the reply body when its turn has a parent message', () => {
    const activity = {
      id: 'activity-id',
      text: '',
      isUser: false,
      timestamp: 10,
      pubkey: 'sol-agent-id',
      isAgentAuthor: true,
      isAgentActivity: true,
      requestId: 'turn-id',
      activity: [{ kind: 'output' as const, title: 'Output', text: 'A heads-up from the turn.' }],
    };
    const final = {
      id: 'agent-final-message-id',
      text: 'Final answer',
      isUser: false,
      timestamp: 11,
      pubkey: 'sol-agent-id',
      isAgentAuthor: true,
      requestId: 'turn-id',
      reference: {
        channelId: 'corner-id',
        eventId: 'agent-final-message-id',
        rootId: 'agent-final-message-id',
      },
    };
    const parent = activityReplyParent(activity, [activity, final]);

    expect(parent).toBe(final);
    const target = activityMessageReplyTarget(activity, [activity, final], {
      messageId: activity.id,
      authorName: 'Sol',
      authorHandle: 'sol',
      authorPubkey: 'sol-agent-id',
      isAgent: true,
      preview: 'Agent activity',
    });
    expect(target).toMatchObject({
      preview: final.text,
      reference: final.reference,
    });
    expect(prepareMessageReply('@sol Why?', target)).toEqual({
      text: '@sol Why?',
      reference: final.reference,
      agentPubkey: 'sol-agent-id',
    });
  });

  it('falls back to the latest message from that agent when the turn has no final', () => {
    const latestAgentMessage = {
      id: 'previous-agent-message',
      text: 'Previous answer',
      isUser: false,
      timestamp: 9,
      pubkey: 'sol-agent-id',
      isAgentAuthor: true,
      requestId: 'previous-turn',
      reference: {
        channelId: 'corner-id',
        eventId: 'previous-agent-message',
        rootId: 'previous-agent-message',
      },
    };
    const activity = {
      id: 'activity-id',
      text: '',
      isUser: false,
      timestamp: 10,
      pubkey: 'sol-agent-id',
      isAgentAuthor: true,
      isAgentActivity: true,
      requestId: 'current-turn',
      activity: [{ kind: 'output' as const, title: 'Output', text: 'Still working.' }],
    };

    expect(activityReplyParent(activity, [latestAgentMessage, activity])).toBe(latestAgentMessage);
  });

  it('sends an addressed message without copying working tool activity into the body', () => {
    const activity = {
      id: 'tool-id',
      text: '',
      isUser: false,
      timestamp: 10,
      pubkey: 'sol-agent-id',
      isAgentAuthor: true,
      isAgentActivity: true,
      requestId: 'working-turn',
      activity: [
        { kind: 'tool' as const, title: 'Run tests', command: 'npm test', status: 'running' },
      ],
    };
    const excerpt = agentActivityReplyExcerpt(activity);

    expect(activityReplyParent(activity, [activity])).toBeUndefined();
    expect(
      prepareMessageReply('@sol Check the mobile suite too.', {
        messageId: activity.id,
        authorName: 'Sol',
        authorHandle: 'sol',
        authorPubkey: 'sol-agent-id',
        isAgent: true,
        preview: excerpt,
      }),
    ).toEqual({
      text: '@sol Check the mobile suite too.',
      agentPubkey: 'sol-agent-id',
    });
  });
});
