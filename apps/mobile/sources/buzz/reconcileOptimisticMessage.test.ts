import { describe, expect, it } from 'vitest';
import { reconcileOptimisticMessage } from './reconcileOptimisticMessage';

type Message = {
  id: string;
  text: string;
};

describe('reconcileOptimisticMessage', () => {
  const optimistic: Message = { id: 'optimistic-1', text: 'hello' };
  const relay: Message = { id: 'event-1', text: 'hello' };

  it('rekeys the optimistic message when the publish response arrives first', () => {
    expect(
      reconcileOptimisticMessage([optimistic], optimistic.id, relay.id),
    ).toEqual([{ ...optimistic, id: relay.id }]);
  });

  it('removes the optimistic duplicate when the relay event arrives first', () => {
    expect(
      reconcileOptimisticMessage([optimistic, relay], optimistic.id, relay.id),
    ).toEqual([relay]);
  });

  it('leaves unrelated messages untouched', () => {
    const unrelated = { id: 'event-2', text: 'other' };
    expect(
      reconcileOptimisticMessage([unrelated], optimistic.id, relay.id),
    ).toEqual([unrelated]);
  });
});
