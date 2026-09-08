import React from 'react';
import { Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { HullDialog, HullDialogInput } from './HullDialog';
import { RepoPicker } from './RepoPicker';

type Props = {
  visible: boolean;
  workspaceName: string;
  roomName: string;
  setRoomName: (name: string) => void;
  creatingRoom: boolean;
  createRoom: () => void;
  onClose: () => void;
  pendingRepo: RepoCandidate | null;
  showRepoPicker: boolean;
  handleToggleRepoPicker: () => void;
  handleSelectNoRepository: () => void;
  handleSelectRepoCandidate: (repo: RepoCandidate) => void;
  repoCandidates: RepoCandidate[];
  repoInstallations: GitHubInstallationAccess[];
  repoPickerError: string | null;
};

const CREATE_CONTENT_PADDING_TOP = 16;
const PICKER_MARGIN_TOP = 8;
const NO_REPOSITORY_ROW_HEIGHT = 44;
const REPOSITORY_SEARCH_HEIGHT = 42;
const REPOSITORY_ERROR_HEIGHT = 40;

export function availableRepositoryPickerHeight(
  bodyHeight: number | undefined,
  controlsHeight: number | undefined,
) {
  if (bodyHeight === undefined || controlsHeight === undefined) return undefined;
  return Math.max(
    0,
    Math.floor(bodyHeight - controlsHeight - CREATE_CONTENT_PADDING_TOP - PICKER_MARGIN_TOP),
  );
}

export function NewRoomDialog({
  visible,
  workspaceName,
  roomName,
  setRoomName,
  creatingRoom,
  createRoom,
  onClose,
  pendingRepo,
  showRepoPicker,
  handleToggleRepoPicker,
  handleSelectNoRepository,
  handleSelectRepoCandidate,
  repoCandidates,
  repoInstallations,
  repoPickerError,
}: Props) {
  const { height } = useWindowDimensions();
  const [bodyHeight, setBodyHeight] = React.useState<number>();
  const [controlsHeight, setControlsHeight] = React.useState<number>();
  const pickerHeight = availableRepositoryPickerHeight(bodyHeight, controlsHeight);
  const listMaxHeight =
    pickerHeight === undefined
      ? undefined
      : Math.max(
          0,
          pickerHeight -
            NO_REPOSITORY_ROW_HEIGHT -
            REPOSITORY_SEARCH_HEIGHT -
            (repoPickerError ? REPOSITORY_ERROR_HEIGHT : 0),
        );
  return (
    <HullDialog
      actions={[
        { label: 'Cancel', onPress: onClose, variant: 'quiet' },
        {
          label: creatingRoom ? 'Creating' : 'Create',
          onPress: () => void createRoom(),
          disabled: !roomName.trim() || creatingRoom,
          busy: creatingRoom,
          variant: 'primary',
          testID: 'create-room-submit',
        },
      ]}
      body={showRepoPicker ? undefined : `In ${workspaceName}. Repository optional.`}
      onContentLayout={setBodyHeight}
      onRequestClose={onClose}
      surfaceStyle={{ maxHeight: height - 48 }}
      testID="new-room-dialog"
      title={`New ${ROOM_LABEL}`}
      visible={visible}
    >
      <View style={styles.createRoomContent}>
        <View
          onLayout={(event) => setControlsHeight(event.nativeEvent.layout.height)}
          style={styles.roomControls}
          testID="create-room-controls"
        >
          <Text style={styles.fieldLabel}>Room name</Text>
          <HullDialogInput
            accessibilityLabel={`${ROOM_LABEL} name`}
            autoFocus
            editable={!creatingRoom}
            onChangeText={setRoomName}
            onSubmitEditing={() => void createRoom()}
            placeholder="#room-name"
            testID="create-room-name"
            value={roomName}
          />
          {!roomName.trim() && (
            <Text testID="create-room-name-hint" style={styles.hint}>
              Enter a Room name to create it.
            </Text>
          )}
          <TouchableOpacity
            accessibilityRole="button"
            disabled={creatingRoom}
            onPress={() => void handleToggleRepoPicker()}
            style={styles.repoRow}
            testID="create-room-repo-row"
          >
            <Text style={styles.repoRowLabel}>REPO</Text>
            <Text numberOfLines={1} style={styles.repoRowValue}>
              {showRepoPicker
                ? 'Choose a repository'
                : pendingRepo
                  ? `▢ ${pendingRepo.name}`
                  : 'No repository (chat only)'}
            </Text>
            <Text style={styles.repoRowChevron}>{showRepoPicker ? '⌄' : '›'}</Text>
          </TouchableOpacity>
        </View>
        {showRepoPicker && (
          <View
            style={[styles.picker, pickerHeight === undefined ? undefined : { maxHeight: pickerHeight }]}
            testID="create-room-picker"
          >
            <TouchableOpacity
              accessibilityRole="button"
              onPress={handleSelectNoRepository}
              style={styles.noRepoRow}
              testID="create-room-no-repository"
            >
              <Text style={styles.noRepoRowText}>No repository (chat only)</Text>
            </TouchableOpacity>
            <RepoPicker
              candidates={repoCandidates}
              currentKey={pendingRepo?.key ?? null}
              error={repoPickerError}
              installations={repoInstallations}
              listMaxHeight={listMaxHeight}
              onSelect={handleSelectRepoCandidate}
              testIDPrefix="create-room-repo-picker"
            />
          </View>
        )}
      </View>
    </HullDialog>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    createRoomContent: { flexShrink: 1, minHeight: 0, paddingTop: 16 },
    roomControls: { gap: 8 },
    repoRow: {
      marginTop: 10,
      // A fixed height: on some devices a minimum height collapses until first tap.
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    repoRowLabel: { ...hull.type.sectionHead, color: hull.textMuted },
    repoRowValue: {
      ...hull.type.meta,
      flex: 1,
      minWidth: 0,
      textAlign: 'right',
      color: hull.textSecondary,
    },
    repoRowChevron: { ...hull.type.body, color: hull.chrome },
    noRepoRow: {
      minHeight: 44,
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    noRepoRowText: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textSecondary,
    },
    fieldLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textPrimary },
    hint: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    picker: { flexShrink: 1, minHeight: 0, marginTop: 8, overflow: 'hidden' },
  };
});
