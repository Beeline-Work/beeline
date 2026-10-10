import { describe, expect, it } from 'vitest';
import { clientResetGeneration, resetClientState, subscribeClientReset } from './client-reset';

describe('client reset', () => {
  it('advances the generation before listeners run and stops calling an unsubscribed listener', () => {
    const start = clientResetGeneration();
    const seen: number[] = [];
    const stop = subscribeClientReset(() => { seen.push(clientResetGeneration()); });
    resetClientState();
    stop();
    resetClientState();
    expect(seen).toEqual([start + 1]);
    expect(clientResetGeneration()).toBe(start + 2);
  });
});
