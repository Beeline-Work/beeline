import { describe, expect, it } from 'vitest';

import {
  answerPrefillCandidate,
  planAnswerPrefill,
  planReplyPrefill,
  type ComposerPrefill,
} from './composer-prefill';
import { prepareMessageReply } from './message-reply';
import type { ChatDisplayMessage } from './room-view-presentation';

const ME = 'me-pubkey';
const OTHER = 'other-pubkey';
const SOL = 'sol-agent-id';

const handleFor = (message: ChatDisplayMessage) =>
  message.pubkey === SOL ? 'sol' : message.authorIdentity?.handle;

function human(id: string, pubkey: string, text = 'Can you check?'): ChatDisplayMessage {
  return { id, text, isUser: pubkey === ME, timestamp: 1, pubkey };
}

function agent(id: string, fields: Partial<ChatDisplayMessage> = {}): ChatDisplayMessage {
  return {
    id,
    text: 'Done.',
    isUser: false,
    timestamp: 2,
    pubkey: SOL,
    isAgentAuthor: true,
    ...fields,
  };
}

const answerPrefill = (sourceMessageId: string): ComposerPrefill => ({
  kind: 'answer',
  text: '@sol ',
  handle: 'sol',
  sourceMessageId,
});

describe('quote-reply prefill', () => {
  const reply = { handle: 'sol', pubkey: SOL, sourceMessageId: 'agent-1' };

  it('starts an empty composer with the agent handle', () => {
    expect(planReplyPrefill({ draft: '', prefill: null, ...reply })).toEqual({
      kind: 'fill',
      text: '@sol ',
      prefill: { kind: 'reply', text: '@sol ', handle: 'sol', sourceMessageId: 'agent-1' },
    });
  });

  it('wakes nobody once the person deletes the handle', () => {
    const target = {
      messageId: 'agent-1',
      authorName: 'Sol',
      authorHandle: 'sol',
      authorPubkey: SOL,
      isAgent: true,
      preview: 'Done.',
    };
    expect(prepareMessageReply('@sol Thanks', target).agentPubkey).toBe(SOL);
    expect(prepareMessageReply('Thanks', target)).toEqual({ text: 'Thanks' });
  });

  it('keeps a started draft and adds the handle in front', () => {
    expect(planReplyPrefill({ draft: 'what about tests?', prefill: null, ...reply })).toEqual({
      kind: 'fill',
      text: '@sol what about tests?',
      prefill: null,
    });
  });

  it('leaves a draft that already tags the agent', () => {
    expect(planReplyPrefill({ draft: 'hey @sol', prefill: null, ...reply })).toEqual({
      kind: 'keep',
    });
  });

  it('replaces an untouched prefill from another agent', () => {
    const goosy: ComposerPrefill = {
      kind: 'answer',
      text: '@goosy ',
      handle: 'goosy',
      sourceMessageId: 'goosy-1',
    };
    expect(planReplyPrefill({ draft: '@goosy ', prefill: goosy, ...reply })).toMatchObject({
      kind: 'fill',
      text: '@sol ',
    });
  });
});

describe('answer prefill', () => {
  it('offers the handle to the person the agent answered by tag', () => {
    const messages = [human('h-1', ME), agent('a-1', { mentionPubkeys: [ME] })];
    expect(answerPrefillCandidate(messages, ME, handleFor)).toEqual({
      handle: 'sol',
      pubkey: SOL,
      sourceMessageId: 'a-1',
    });
  });

  it('offers the handle to the person the agent answered by quote-reply', () => {
    const messages = [human('h-1', ME), agent('a-1', { replyToId: 'h-1' })];
    expect(answerPrefillCandidate(messages, ME, handleFor)?.sourceMessageId).toBe('a-1');
  });

  it.each(['h-1', 'relay-h-1'])('R1: fills only the requester composer for requestId %s', (requestId) => {
    const messages = [
      { ...human('h-1', ME, '@charles can you find me this for luna?'), relayId: 'relay-h-1' },
      agent('charles-answer', { requestId }),
    ];
    const charlesHandle = () => 'charles';
    const candidate = answerPrefillCandidate(messages, ME, charlesHandle);
    expect(planAnswerPrefill({ draft: '', prefill: null, candidate, offered: new Set() }))
      .toMatchObject({ kind: 'fill', text: '@charles ' });
    expect(answerPrefillCandidate(messages, OTHER, charlesHandle)).toBeUndefined();
  });

  it('does not prefill when the request message is not loaded', () => {
    expect(answerPrefillCandidate([agent('a-1', { requestId: 'unloaded' })], ME, handleFor))
      .toBeUndefined();
  });

  it('offers nothing to another person viewing the same Room', () => {
    const messages = [human('h-1', ME), agent('a-1', { mentionPubkeys: [ME], replyToId: 'h-1' })];
    expect(answerPrefillCandidate(messages, OTHER, handleFor)).toBeUndefined();
  });

  it('offers nothing when the agent answers without tagging or replying', () => {
    expect(answerPrefillCandidate([human('h-1', ME), agent('a-1')], ME, handleFor)).toBeUndefined();
  });

  it('offers nothing when a newer message follows the answer', () => {
    const messages = [agent('a-1', { mentionPubkeys: [ME] }), human('h-2', OTHER)];
    expect(answerPrefillCandidate(messages, ME, handleFor)).toBeUndefined();
  });

  it('ignores live turn rows when it reads the newest message', () => {
    const messages = [
      agent('a-1', { mentionPubkeys: [ME] }),
      agent('activity', { isAgentActivity: true }),
    ];
    expect(answerPrefillCandidate(messages, ME, handleFor)?.sourceMessageId).toBe('a-1');
  });

  const candidate = { handle: 'sol', pubkey: SOL, sourceMessageId: 'a-1' };

  it('fills an empty composer', () => {
    expect(planAnswerPrefill({ draft: '', prefill: null, candidate, offered: new Set() })).toEqual({
      kind: 'fill',
      text: '@sol ',
      prefill: answerPrefill('a-1'),
    });
  });

  it('never touches text the person typed, including a restored draft', () => {
    expect(
      planAnswerPrefill({ draft: 'half a thought', prefill: null, candidate, offered: new Set() }),
    ).toEqual({ kind: 'keep' });
    expect(
      planAnswerPrefill({ draft: '@sol ', prefill: null, candidate, offered: new Set() }),
    ).toEqual({ kind: 'keep' });
  });

  it('clears an untouched prefill when the newer message does not qualify', () => {
    expect(
      planAnswerPrefill({
        draft: '@sol ',
        prefill: answerPrefill('a-1'),
        candidate: undefined,
        offered: new Set(['a-1']),
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('recomputes an untouched prefill for a newer answer', () => {
    expect(
      planAnswerPrefill({
        draft: '@sol ',
        prefill: answerPrefill('a-1'),
        candidate: { ...candidate, sourceMessageId: 'a-2' },
        offered: new Set(['a-1']),
      }),
    ).toEqual({ kind: 'fill', text: '@sol ', prefill: answerPrefill('a-2') });
  });

  it('does not add a deleted prefill again for the same answer', () => {
    expect(
      planAnswerPrefill({
        draft: '',
        prefill: answerPrefill('a-1'),
        candidate,
        offered: new Set(['a-1']),
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('keeps an edited prefill', () => {
    expect(
      planAnswerPrefill({
        draft: '@sol thanks',
        prefill: answerPrefill('a-1'),
        candidate: undefined,
        offered: new Set(['a-1']),
      }),
    ).toEqual({ kind: 'keep' });
  });

  it('leaves a quote-reply prefill to its reply', () => {
    expect(
      planAnswerPrefill({
        draft: '@sol ',
        prefill: { ...answerPrefill('a-1'), kind: 'reply' },
        candidate: undefined,
        offered: new Set(),
      }),
    ).toEqual({ kind: 'keep' });
  });
});

describe('first-message prefill through the answer rule', () => {
  const first = { roomId: 'room-1', agents: [{ pubkey: SOL, handle: 'sol' }], viewerIsAgent: false };
  const candidateFor = (messages: ChatDisplayMessage[] = [], context = first) =>
    answerPrefillCandidate(messages, ME, handleFor, context);

  it.each([{ messages: [] }, { messages: [agent('hello')] }])('offers the sole member before the viewer has spoken: %j', ({ messages }) => {
    const candidate = candidateFor(messages);
    expect(candidate).toEqual({ handle: 'sol', pubkey: SOL, sourceMessageId: `first-message:room-1:${SOL}` });
    expect(planAnswerPrefill({ draft: '', prefill: null, candidate, offered: new Set() }))
      .toMatchObject({ kind: 'fill', text: '@sol ' });
  });

  it('does not guess between two agents, even when only one has said hello', () => {
    expect(candidateFor([agent('hello')], { ...first, agents: [...first.agents, { pubkey: OTHER, handle: 'other' }] }))
      .toBeUndefined();
    expect(candidateFor([], { ...first, agents: [] })).toBeUndefined();
  });

  it('keeps an existing draft', () => {
    expect(planAnswerPrefill({ draft: 'Keep my thought', prefill: null, candidate: candidateFor(), offered: new Set() }))
      .toEqual({ kind: 'keep' });
  });

  it('offers nothing to an agent viewer', () => {
    expect(candidateFor([agent('hello')], { ...first, viewerIsAgent: true })).toBeUndefined();
  });

  it('does not reinsert a deleted first-message tag when the hello arrives', () => {
    const candidate = candidateFor([agent('hello')]);
    expect(planAnswerPrefill({ draft: '', prefill: null, candidate,
      offered: new Set([`first-message:room-1:${SOL}`]) })).toEqual({ kind: 'keep' });
  });

  it('leaves the existing answer rule in charge after the viewer speaks', () => {
    expect(candidateFor([human('h1', ME), agent('hello')])).toBeUndefined();
    expect(candidateFor([human('h1', ME), agent('answer', { requestId: 'h1' })])?.sourceMessageId)
      .toBe('answer');
  });
});
