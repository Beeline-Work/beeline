export function roomMemberManagementState({
  isDirectMessage,
  participantsHydrated,
  rosterRequested,
  pickerRequested,
}: {
  isDirectMessage: boolean;
  participantsHydrated: boolean;
  rosterRequested: boolean;
  pickerRequested: boolean;
}) {
  return {
    canOpenRoster: !isDirectMessage && participantsHydrated,
    rosterVisible: !isDirectMessage && rosterRequested,
    pickerVisible: !isDirectMessage && pickerRequested,
  };
}
