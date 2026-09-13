import { describe, expect, it } from 'vitest';

import {
  activityMessageReplyTarget,
  activityReplyParent,
  agentActivityReplyExcerpt,
  prepareMessageReply,
  replyMessageText,
} from './message-reply';

describe('message replies', () => {
  it('encodes an agent reply as an exact canonical tag', () => {
    expect(replyMessageText('  Can you expand on that?  ', 'codex')).toBe(
      '@codex Can you expand on that?',
    );
  });

  it('keeps a human reply untagged', () => {
    expect(replyMessageText('  Thanks  ')).toBe('Thanks');
  });

  it('keeps a corner agent reply bound to its parent and exact agent', () => {
    const reference = {
      channelId: 'corner-id',
      eventId: 'agent-final-message-id',
      rootId: 'agent-final-message-id',
    };

    expect(
      prepareMessageReply('  Can you clarify?  ', {
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

  it('maps narration to its turn final while quoting the selected excerpt', () => {
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
    const excerpt = agentActivityReplyExcerpt(activity);

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
      preview: excerpt,
      quotedExcerpt: excerpt,
      reference: final.reference,
    });
    expect(prepareMessageReply('Why?', target)).toEqual({
      text: '> A heads-up from the turn.\n\n@sol Why?',
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

  it('turns working tool activity with no parent into an addressed quoted steer', () => {
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
      prepareMessageReply('Check the mobile suite too.', {
        messageId: activity.id,
        authorName: 'Sol',
        authorHandle: 'sol',
        authorPubkey: 'sol-agent-id',
        isAgent: true,
        preview: excerpt,
        quotedExcerpt: excerpt,
      }),
    ).toEqual({
      text: '> Run tests · npm test\n\n@sol Check the mobile suite too.',
      agentPubkey: 'sol-agent-id',
    });
  });
});
