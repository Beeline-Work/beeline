import React from 'react';
import { ScrollView, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import {
  HULL_DIALOG_LAYOUT,
  HullDialog,
  HullDialogInput,
  hullDialogMinimumHeight,
} from './HullDialog';
import { RepoPicker } from './RepoPicker';

const DIALOG_VIEWPORT_GUTTER = 48;
const PICKER_DIALOG_HEIGHT = 520;
const NEW_ROOM_FORM_LAYOUT = {
  contentPaddingTop: 16,
  controlsGap: 8,
  fieldLabelLineHeight: 15,
  hintLineHeight: 19,
  repoRowHeight: 44,
  repoRowMarginTop: 10,
} as const;
const NEW_ROOM_FORM_CONTENT_HEIGHT =
  NEW_ROOM_FORM_LAYOUT.contentPaddingTop +
  NEW_ROOM_FORM_LAYOUT.fieldLabelLineHeight +
  NEW_ROOM_FORM_LAYOUT.controlsGap +
  HULL_DIALOG_LAYOUT.inputMarginTop +
  HULL_DIALOG_LAYOUT.inputMinHeight +
  NEW_ROOM_FORM_LAYOUT.controlsGap +
  NEW_ROOM_FORM_LAYOUT.hintLineHeight +
  NEW_ROOM_FORM_LAYOUT.controlsGap +
  NEW_ROOM_FORM_LAYOUT.repoRowMarginTop +
  NEW_ROOM_FORM_LAYOUT.repoRowHeight;
const FORM_DIALOG_MIN_HEIGHT = hullDialogMinimumHeight(NEW_ROOM_FORM_CONTENT_HEIGHT, true);

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
  const availableDialogHeight = Math.max(0, height - DIALOG_VIEWPORT_GUTTER);
  const dialogMinHeight = Math.min(
    showRepoPicker ? PICKER_DIALOG_HEIGHT : FORM_DIALOG_MIN_HEIGHT,
    availableDialogHeight,
  );
  const roomControls = (
    <View style={styles.roomControls}>
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
      onRequestClose={onClose}
      surfaceStyle={{ minHeight: dialogMinHeight, maxHeight: availableDialogHeight }}
      testID="new-room-dialog"
      title={`New ${ROOM_LABEL}`}
      visible={visible}
    >
      {showRepoPicker ? (
        <View style={styles.createRoomContent}>
          {roomControls}
          <View style={styles.picker} testID="create-room-picker">
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
              fillAvailableHeight
              installations={repoInstallations}
              onSelect={handleSelectRepoCandidate}
              testIDPrefix="create-room-repo-picker"
            />
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.formScrollContent}
          style={styles.formScroll}
          testID="create-room-form"
        >
          {roomControls}
        </ScrollView>
      )}
    </HullDialog>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    createRoomContent: {
      flex: 1,
      flexShrink: 1,
      minHeight: 0,
      overflow: 'hidden',
      paddingTop: NEW_ROOM_FORM_LAYOUT.contentPaddingTop,
    },
    formScroll: { flex: 1, flexShrink: 1, minHeight: 0 },
    formScrollContent: {
      minHeight: NEW_ROOM_FORM_CONTENT_HEIGHT,
      paddingTop: NEW_ROOM_FORM_LAYOUT.contentPaddingTop,
    },
    roomControls: { gap: NEW_ROOM_FORM_LAYOUT.controlsGap },
    repoRow: {
      marginTop: NEW_ROOM_FORM_LAYOUT.repoRowMarginTop,
      // A fixed height: on some devices a minimum height collapses until first tap.
      height: NEW_ROOM_FORM_LAYOUT.repoRowHeight,
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
    fieldLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      lineHeight: NEW_ROOM_FORM_LAYOUT.fieldLabelLineHeight,
      color: hull.textPrimary,
    },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      lineHeight: NEW_ROOM_FORM_LAYOUT.hintLineHeight,
      color: hull.textMuted,
    },
    picker: { flex: 1, flexShrink: 1, minHeight: 0, marginTop: 8, overflow: 'hidden' },
  };
});
