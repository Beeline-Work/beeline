import { describe, expect, it, vi } from 'vitest';
import {
  forwardMessageToNewCorner,
  stageCornerComposerDraft,
  takeCornerComposerDraft,
} from './message-corner-forward';

describe('forwardMessageToNewCorner', () => {
  it('creates a human corner after confirmation and stages the forward for its composer', async () => {
    const createCorner = vi.fn(async () => 'corner-1');
    let draftWhenOpened: string | undefined;
    const openCorner = vi.fn((cornerId: string) => {
      // The corner screen reads the draft as it mounts.
      draftWhenOpened = takeCornerComposerDraft(cornerId);
    });

    await expect(
      forwardMessageToNewCorner({
        confirm: async () => true,
        forwardText: '> hello\n\nFORWARDED FROM #general · @alice',
        createCorner,
        roomId: 'room-1',
        openCorner,
        random: () => 0,
      }),
    ).resolves.toEqual({ id: 'corner-1', title: 'quiet amber corner' });

    expect(createCorner).toHaveBeenCalledWith('room-1', 'quiet amber corner');
    expect(openCorner).toHaveBeenCalledWith('corner-1', 'quiet amber corner');
    expect(draftWhenOpened).toBe('> hello\n\nFORWARDED FROM #general · @alice');
    expect(takeCornerComposerDraft('corner-1')).toBeUndefined();
  });

  it('hands a staged draft out once', () => {
    stageCornerComposerDraft('corner-3', 'draft');
    expect(takeCornerComposerDraft('corner-3')).toBe('draft');
    expect(takeCornerComposerDraft('corner-3')).toBeUndefined();
  });

  it('creates nothing when the person declines', async () => {
    const createCorner = vi.fn(async () => 'corner-2');
    const openCorner = vi.fn();

    await expect(
      forwardMessageToNewCorner({
        confirm: async () => false,
        forwardText: '> hello',
        createCorner,
        roomId: 'room-1',
        openCorner,
      }),
    ).resolves.toBeNull();

    expect(createCorner).not.toHaveBeenCalled();
    expect(openCorner).not.toHaveBeenCalled();
    expect(takeCornerComposerDraft('corner-2')).toBeUndefined();
  });
});
