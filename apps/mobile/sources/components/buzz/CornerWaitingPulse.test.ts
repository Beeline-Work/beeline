import { describe, expect, it } from 'vitest';
import { WAITING_PULSE_CYCLE, waitingPulseOpacity } from './CornerWaitingPulse';

describe('waiting pulse clock', () => {
  it('is one slow breath, slower than the 1120 ms live pulse', () => {
    expect(WAITING_PULSE_CYCLE).toBeGreaterThan(1120);
    expect(waitingPulseOpacity(0)).toBeCloseTo(1);
    expect(waitingPulseOpacity(WAITING_PULSE_CYCLE / 2)).toBeCloseTo(0.45);
  });

  it('gives every label the same opacity at the same frame time', () => {
    for (const at of [0, 317, 1200, 2399]) {
      expect(waitingPulseOpacity(at + WAITING_PULSE_CYCLE * 7)).toBeCloseTo(
        waitingPulseOpacity(at),
      );
    }
  });
});
