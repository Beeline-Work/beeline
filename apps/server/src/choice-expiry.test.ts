import { describe, expect, it, vi } from 'vitest';

vi.mock('./room-choice.js', () => ({
  closeExpiredChoices: vi.fn(async () => 2),
}));

import { ChoiceExpiryLoop } from './choice-expiry.js';
import { closeExpiredChoices } from './room-choice.js';

describe('ChoiceExpiryLoop', () => {
  it('sweeps at most once per interval', async () => {
    const loop = new ChoiceExpiryLoop({} as never, 5_000);
    expect(await loop.runOnce(10_000)).toBe(2);
    expect(await loop.runOnce(14_999)).toBe(0);
    expect(await loop.runOnce(15_000)).toBe(2);
    expect(vi.mocked(closeExpiredChoices)).toHaveBeenCalledTimes(2);
  });
});
