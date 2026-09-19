import React from 'react';
import { HullActionSheetRow } from './HullActionSheet';

type RoomRepositoryActionsProps = {
  busy: boolean;
  canManage: boolean;
  notifications?: React.ReactNode;
  onToggle: () => void;
  picker: React.ReactNode;
  pickerVisible: boolean;
  reviewer?: React.ReactNode;
  repositoryName: string | null;
};

export function RoomRepositoryActions({
  busy,
  canManage,
  notifications,
  onToggle,
  picker,
  pickerVisible,
  reviewer,
  repositoryName,
}: RoomRepositoryActionsProps) {
  if (!canManage) {
    return (
      <HullActionSheetRow
        label="Repo"
        metadata={repositoryName ?? 'None'}
        testID="room-repo-readonly"
      />
    );
  }
  return (
    <>
      <HullActionSheetRow
        accessibilityLabel={
          repositoryName ? `Change repo, currently ${repositoryName}` : 'Link a repo'
        }
        chevron={pickerVisible ? 'down' : 'right'}
        description={
          repositoryName
            ? 'Corners in this Room tree off this repo.'
            : 'A Room needs a repo before a Corner can open.'
        }
        disabled={busy}
        label="Repo"
        metadata={repositoryName ?? 'None'}
        onPress={onToggle}
        testID="room-repo-action"
      />
      {reviewer}
      {pickerVisible ? picker : null}
      {notifications}
    </>
  );
}
