import { describe, expect, it, vi } from 'vitest';
import { copyEntireTurn } from './message-copy';

describe('copyEntireTurn', () => {
  it('copies every committed paragraph and machine line without truncation', async () => {
    const write = vi.fn(async () => undefined);
    const turn = 'First paragraph.\n\nSecond paragraph.\n$ git status\nclean';

    await copyEntireTurn(turn, write);

    expect(write).toHaveBeenCalledWith(turn);
  });
});
