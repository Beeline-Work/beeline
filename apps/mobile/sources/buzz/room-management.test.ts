import { describe, expect, it } from 'vitest';
import {
  canRemoveRoomParticipant,
  normalizedRoomRole,
  roomLifecycleAction,
} from './room-management';

describe('Room management capabilities', () => {
  it('shows delete to owners/admins and leave only to normal members', () => {
    expect(roomLifecycleAction('owner')).toBe('delete');
    expect(roomLifecycleAction('admin')).toBe('delete');
    expect(roomLifecycleAction('member')).toBe('leave');
    expect(roomLifecycleAction(null)).toBeNull();
  });

  it('never exposes member removal to a non-admin', () => {
    expect(canRemoveRoomParticipant('member', 'member', false)).toBe(false);
    expect(canRemoveRoomParticipant(null, 'member', false)).toBe(false);
  });

  it('keeps owner and peer-admin authority protected', () => {
    expect(canRemoveRoomParticipant('admin', 'owner', false)).toBe(false);
    expect(canRemoveRoomParticipant('admin', 'admin', false)).toBe(false);
    expect(canRemoveRoomParticipant('owner', 'admin', false)).toBe(true);
    expect(canRemoveRoomParticipant('owner', 'member', true)).toBe(false);
  });

  it('normalizes projection roles without granting unknown values authority', () => {
    expect(normalizedRoomRole({ pubkey: 'a', role: 'owner' })).toBe('owner');
    expect(normalizedRoomRole({ pubkey: 'a', role: 'admin' })).toBe('admin');
    expect(normalizedRoomRole({ pubkey: 'a', role: 'unexpected' })).toBe('member');
    expect(normalizedRoomRole(undefined)).toBeNull();
  });
});
