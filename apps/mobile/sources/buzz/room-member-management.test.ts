import { describe, expect, it } from 'vitest';
import { roomMemberManagementState } from './room-member-management';

describe('Room member-management visibility', () => {
  it('keeps every member-management entry point closed in a direct message', () => {
    expect(
      roomMemberManagementState({
        isDirectMessage: true,
        participantsHydrated: true,
        rosterRequested: true,
        pickerRequested: true,
      }),
    ).toEqual({ canOpenRoster: false, rosterVisible: false, pickerVisible: false });
  });

  it('preserves member management for hydrated Rooms and corners', () => {
    expect(
      roomMemberManagementState({
        isDirectMessage: false,
        participantsHydrated: true,
        rosterRequested: true,
        pickerRequested: true,
      }),
    ).toEqual({ canOpenRoster: true, rosterVisible: true, pickerVisible: true });
  });

  it('does not open a Room roster before its participants are hydrated', () => {
    expect(
      roomMemberManagementState({
        isDirectMessage: false,
        participantsHydrated: false,
        rosterRequested: false,
        pickerRequested: false,
      }).canOpenRoster,
    ).toBe(false);
  });
});
