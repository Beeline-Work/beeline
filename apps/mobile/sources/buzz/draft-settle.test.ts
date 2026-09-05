import { afterEach, describe, expect, it } from 'vitest';
import {
  draftRequestId,
  joinedTurnRowId,
  liveDraftRowId,
  provisionalDraftKey,
  rememberProvisionalDraft,
  resetProvisionalDrafts,
  takeProvisionalDraft,
} from './draft-settle';

afterEach(() => resetProvisionalDrafts());

describe('provisional draft memory', () => {
  it('reads the request id out of both live draft row ids, and nothing else', () => {
    const goosy = 'a'.repeat(64);
    expect(draftRequestId(liveDraftRowId(goosy, 'request-1'))).toBe('request-1');
    expect(draftRequestId(joinedTurnRowId(goosy, 'request-1'))).toBe('request-1');
    expect(draftRequestId('some-durable-message-id')).toBeUndefined();
    expect(draftRequestId('live-turn:')).toBeUndefined();
    // The pre-author shape is not a draft row id: it named two agents at once.
    expect(draftRequestId('live-turn:request-1')).toBeUndefined();
  });

  it('names a row by author AND request, so two agents on one request differ', () => {
    // A human message addressing two agents starts two turns under the SAME
    // request id (`monolith-room-turn.ts` posts `requestId: item.id`). The
    // transcript is keyed by row id, so the author has to be in it.
    const goosy = 'a'.repeat(64);
    const terra = 'b'.repeat(64);
    const request = 'c'.repeat(64);
    expect(liveDraftRowId(goosy, request)).not.toBe(liveDraftRowId(terra, request));
    expect(draftRequestId(liveDraftRowId(goosy, request))).toBe(request);
    expect(draftRequestId(liveDraftRowId(terra, request))).toBe(request);
  });

  it('hands the last streamed text to the reply that settles it, exactly once', () => {
    const key = provisionalDraftKey('a'.repeat(64), 'request-1');
    rememberProvisionalDraft(key, 'The answer is');
    rememberProvisionalDraft(key, 'The answer is 42');
    expect(takeProvisionalDraft(key)).toBe('The answer is 42');
    // Spent: a remount of the settled row must not replay the transition.
    expect(takeProvisionalDraft(key)).toBeUndefined();
  });

  it('never grows without bound', () => {
    for (let index = 0; index < 40; index += 1) {
      rememberProvisionalDraft(provisionalDraftKey('a'.repeat(64), `r${index}`), `draft ${index}`);
    }
    expect(takeProvisionalDraft(provisionalDraftKey('a'.repeat(64), 'r0'))).toBeUndefined();
    expect(takeProvisionalDraft(provisionalDraftKey('a'.repeat(64), 'r39'))).toBe('draft 39');
  });
});
