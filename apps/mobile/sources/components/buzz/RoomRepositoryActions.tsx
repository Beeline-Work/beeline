import React from 'react';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetRow } from './HullActionSheet';

type RoomRepositoryActionsProps = {
  busy: boolean;
  canManage: boolean;
  notifications?: React.ReactNode;
  onToggle: () => void;
  /** Present only when a repo is bound and the viewer may manage it. */
  onUnlink?: () => void;
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
  onUnlink,
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
            ? `${CORNER_LABEL}s in this ${ROOM_LABEL} tree off this repo.`
            : `A ${ROOM_LABEL} needs a repo before a ${CORNER_LABEL} can open.`
        }
        disabled={busy}
        label="Repo"
        metadata={repositoryName ?? 'None'}
        onPress={onToggle}
        testID="room-repo-action"
      />
      {reviewer}
      {repositoryName && onUnlink ? (
        <HullActionSheetRow
          accessibilityLabel={`Unlink repo, currently ${repositoryName}`}
          description={`${CORNER_LABEL}s keep their own repo copies. Messages and history stay.`}
          destructive
          disabled={busy}
          label="Unlink repo"
          onPress={onUnlink}
          testID="room-repo-unlink"
        />
      ) : null}
      {pickerVisible ? picker : null}
      {notifications}
    </>
  );
}
