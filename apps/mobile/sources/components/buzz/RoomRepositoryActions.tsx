import React from 'react';
import { HullActionSheetRow } from './HullActionSheet';

export type RoomRepositoryActionsSlot = 'all' | 'row' | 'body';

type RoomRepositoryActionsProps = {
  busy: boolean;
  canManage: boolean;
  /** Candidate fetch in flight: metadata says Loading only when no repo name yet. */
  loading?: boolean;
  notifications?: React.ReactNode;
  onToggle: () => void;
  picker: React.ReactNode;
  pickerVisible: boolean;
  reviewer?: React.ReactNode;
  repositoryName: string | null;
  /**
   * `row` is the pinned Repo control; `body` is the expanded picker and the
   * rows that follow it; `all` keeps both for hosts that still stack them.
   */
  slot?: RoomRepositoryActionsSlot;
};

export function RoomRepositoryActions({
  busy,
  canManage,
  loading = false,
  notifications,
  onToggle,
  picker,
  pickerVisible,
  reviewer,
  repositoryName,
  slot = 'all',
}: RoomRepositoryActionsProps) {
  const repoMetadata =
    loading && !repositoryName ? 'Loading' : (repositoryName ?? 'None');
  if (!canManage) {
    if (slot === 'body') return null;
    return (
      <HullActionSheetRow
        label="Repo"
        metadata={repoMetadata}
        testID="room-repo-readonly"
      />
    );
  }
  const row = (
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
      metadata={repoMetadata}
      onPress={onToggle}
      testID="room-repo-action"
    />
  );
  const body = (
    <>
      {pickerVisible ? picker : null}
      {reviewer}
      {notifications}
    </>
  );
  if (slot === 'row') return row;
  if (slot === 'body') return body;
  return (
    <>
      {row}
      {body}
    </>
  );
}
