import { afterEach, describe, expect, it } from 'vitest';
import {
  draftRequestId,
  provisionalDraftKey,
  rememberProvisionalDraft,
  resetProvisionalDrafts,
  takeProvisionalDraft,
} from './draft-settle';

afterEach(() => resetProvisionalDrafts());

describe('provisional draft memory', () => {
  it('reads the request id out of both live draft row ids, and nothing else', () => {
    expect(draftRequestId('live-turn:request-1')).toBe('request-1');
    expect(draftRequestId('active-turn-stream:request-1')).toBe('request-1');
    expect(draftRequestId('some-durable-message-id')).toBeUndefined();
    expect(draftRequestId('live-turn:')).toBeUndefined();
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
