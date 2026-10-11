import { describe, expect, it } from 'vitest';
import { resetClientState } from '@/sync/client-reset';
import { cornerOpenStarted, cornerOpenStatus, cornerOpenUnreachable } from './corner-open-status';

describe('corner open status', () => {
  it('returns to idle on a client reset', () => {
    cornerOpenStarted('room-a', 1);
    resetClientState();
    expect(cornerOpenStatus()).toEqual({ status: 'idle' });
    cornerOpenUnreachable('room-a', true, () => undefined);
    resetClientState();
    expect(cornerOpenStatus()).toEqual({ status: 'idle' });
  });
});
