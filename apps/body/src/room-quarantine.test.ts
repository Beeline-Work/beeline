import { describe, expect, it, vi } from 'vitest';
import { RoomQuarantineStateMachine } from './room-quarantine.js';

describe('RoomQuarantineStateMachine', () => {
  it('makes archived evidence from any path terminal and logs one transition', () => {
    const onTransition = vi.fn();
    const state = new RoomQuarantineStateMachine({
      onTransition,
      now: () => 100,
      random: () => 0.5,
    });
    state.noteFailure('room', new Error('publish failed: channel is archived'));
    state.noteFailure('room', new Error('publish failed: channel is archived'));
    expect(state.get('room')?.kind).toBe('terminal-inert');
    expect(state.mayAttempt('room')).toBe(false);
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it('escalates repeated owner grant failures while transport stays short and bounded', () => {
    let now = 1_000;
    const onTransition = vi.fn();
    const state = new RoomQuarantineStateMachine({
      now: () => now,
      random: () => 0.5,
      onTransition,
    });
    expect(state.noteFailure('owner', new Error('owner_grant_needed')).kind).toBe(
      'owner-grant-confirming',
    );
    now += 30_000;
    state.noteFailure('owner', new Error('owner_grant_needed'));
    now += 30_000;
    const owner = state.noteFailure('owner', new Error('owner_grant_needed'));
    expect(owner.kind).toBe('owner-grant-backoff');
    expect(owner.retryAt! - now).toBe(10 * 60_000);
    expect(onTransition).toHaveBeenCalledTimes(2);

    const transport = state.noteFailure('relay', new Error('relay transport reset'));
    expect(transport.kind).toBe('transport-backoff');
    expect(transport.retryAt! - now).toBe(30_000);
    state.noteFailure('relay', new Error('different transport failure'));
    expect(onTransition).toHaveBeenCalledTimes(3);
  });
});
