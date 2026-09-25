import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, validRoomSlug } from '@/buzz/room-name';
import { Typography } from '@/constants/Typography';
import { HullDialogInput } from './HullDialog';
import { HullActionSheetModal, HULL_SHEET_INSET } from './HullActionSheet';
import { RepoPicker } from './RepoPicker';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

type Props = {
  visible: boolean;
  workspaceName: string;
  roomName: string;
  setRoomName: (name: string) => void;
  inviteOnly: boolean;
  setInviteOnly: (value: boolean) => void;
  creatingRoom: boolean;
  creatingRepository?: boolean;
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
  /** Progress line for the GitHub install session that shares the picker's state. */
  repoPickerNotice?: string | null;
  /** Connect a NEW GitHub account/organization (the App's install page). */
  handleAddGitHubAccount?: () => void;
  /** Adjust an existing installation's repository selection on GitHub. */
  handleManageGitHubInstallation?: (installation: GitHubInstallationAccess) => void;
  handleCreateRepository?: (installationId: number, name: string) => Promise<void>;
};

export function NewRoomDialog({
  visible,
  workspaceName,
  roomName,
  setRoomName,
  inviteOnly,
  setInviteOnly,
  creatingRoom,
  creatingRepository = false,
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
  repoPickerNotice,
  handleAddGitHubAccount,
  handleManageGitHubInstallation,
  handleCreateRepository,
}: Props) {
  const { theme } = useUnistyles();
  const roomControls = (
    <View style={styles.roomControls}>
      <Text style={styles.fieldLabel}>Room name</Text>
      <HullDialogInput
        accessibilityLabel={`${ROOM_LABEL} name`}
        autoFocus
        editable={!creatingRoom && !creatingRepository}
        onChangeText={setRoomName}
        onSubmitEditing={() => void createRoom()}
        placeholder="#room-name"
        testID="create-room-name"
        value={roomName}
      />
      {!validRoomSlug(roomName) && (
        <Text testID="create-room-name-hint" style={styles.hint}>
          {ROOM_SLUG_HINT}
        </Text>
      )}
      <TouchableOpacity
        accessibilityRole="button"
        disabled={creatingRoom || creatingRepository}
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
        <ChevronGlyph
          color={styles.repoRowChevron.color}
          direction={showRepoPicker ? 'down' : 'right'}
          size={CHEVRON_ROW_SIZE}
        />
      </TouchableOpacity>
      <View style={styles.visibilityRow}>
        <Text style={styles.visibilityLabel}>Invite-only</Text>
        <Switch
          accessibilityLabel="Invite-only Room"
          disabled={creatingRoom || creatingRepository}
          onValueChange={setInviteOnly}
          testID="create-room-invite-only"
          thumbColor={theme.buzz.textPrimary}
          trackColor={{ false: theme.buzz.bgRaised, true: theme.buzz.accent }}
          value={inviteOnly}
        />
      </View>
    </View>
  );
  return (
    <HullActionSheetModal
      dismissOnBackdrop={!creatingRoom && !creatingRepository}
      onClose={() => {
        if (!creatingRoom && !creatingRepository) onClose();
      }}
      subtitle={`In ${workspaceName}. Repository optional.`}
      testID="new-room-dialog"
      title={`New ${ROOM_LABEL}`}
      visible={visible}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={creatingRoom || creatingRepository}
            onPress={onClose}
            style={styles.action}
            testID="create-room-cancel"
          >
            <Text style={styles.actionText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{
              busy: creatingRoom || creatingRepository,
              disabled: !validRoomSlug(roomName) || creatingRoom || creatingRepository,
            }}
            disabled={!validRoomSlug(roomName) || creatingRoom || creatingRepository}
            onPress={() => void createRoom()}
            style={[
              styles.action,
              styles.primaryAction,
              (!validRoomSlug(roomName) || creatingRoom || creatingRepository) &&
                styles.disabledAction,
            ]}
            testID="create-room-submit"
          >
            <Text style={styles.primaryActionText}>
              {creatingRoom ? 'Creating…' : 'Create Room'}
            </Text>
          </TouchableOpacity>
        </View>
      }
    >
      <View style={styles.form} testID="create-room-content">
        {roomControls}
        {showRepoPicker && (
          <View style={styles.picker} testID="create-room-picker">
            <TouchableOpacity
              accessibilityRole="button"
              disabled={creatingRepository}
              onPress={handleSelectNoRepository}
              style={styles.noRepoRow}
              testID="create-room-no-repository"
            >
              <Text style={styles.noRepoRowText}>No repository (chat only)</Text>
            </TouchableOpacity>
            <RepoPicker
              candidates={repoCandidates}
              busy={creatingRepository}
              currentKey={pendingRepo?.key ?? null}
              error={repoPickerError}
              installations={repoInstallations}
              notice={repoPickerNotice}
              onAddAccount={handleAddGitHubAccount}
              onManageInstallation={handleManageGitHubInstallation}
              onCreateRepository={handleCreateRepository}
              onSelect={handleSelectRepoCandidate}
              testIDPrefix="create-room-repo-picker"
            />
          </View>
        )}
      </View>
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    form: { paddingHorizontal: HULL_SHEET_INSET, paddingBottom: 12 },
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
    repoRowChevron: { color: hull.chrome },
    visibilityRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    visibilityLabel: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
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
      lineHeight: 15,
      color: hull.textPrimary,
    },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      lineHeight: 19,
      color: hull.textMuted,
    },
    picker: { marginTop: 8 },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    action: {
      minHeight: 44,
      minWidth: 72,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
    },
    actionText: {
      ...Typography.mono('semiBold'),
      color: hull.chrome,
      fontSize: 12,
      textTransform: 'uppercase',
    },
    primaryAction: { backgroundColor: hull.accent },
    disabledAction: { opacity: 0.42 },
    primaryActionText: {
      ...Typography.mono('semiBold'),
      color: hull.textInverted,
      fontSize: 12,
      textTransform: 'uppercase',
    },
  };
});
