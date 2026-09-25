import React, { useEffect, useState } from 'react';
import { Keyboard, Switch, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, validRoomSlug } from '@/buzz/room-name';
import { Typography } from '@/constants/Typography';
import { HullDialogInput } from './HullDialog';
import { HullActionSheetModal, HULL_SHEET_INSET } from './HullActionSheet';
import { RepoPicker } from './RepoPicker';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

type Props = {
  visible: boolean;
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
  repoPickerNotice?: string | null;
  handleAddGitHubAccount?: () => void;
  handleManageGitHubInstallation?: (installation: GitHubInstallationAccess) => void;
  handleCreateRepository?: (installationId: number, name: string) => Promise<void>;
};

const validRepositoryName = (name: string) => /^[A-Za-z0-9._-]{1,100}$/.test(name);

export function NewRoomDialog({
  visible,
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
  const [creatingRepoStep, setCreatingRepoStep] = useState(false);
  const [repositoryName, setRepositoryName] = useState('');
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [choosingAccount, setChoosingAccount] = useState(false);
  const activeInstallations = repoInstallations.filter((item) => item.status === 'active');
  const selectedInstallation =
    activeInstallations.find((item) => item.installationId === installationId) ??
    activeInstallations[0];

  useEffect(() => {
    if (visible && showRepoPicker) return;
    setCreatingRepoStep(false);
    setRepositoryName('');
    setChoosingAccount(false);
  }, [visible, showRepoPicker]);

  const closeStep = () => {
    if (creatingRoom || creatingRepository) return;
    if (creatingRepoStep) {
      setCreatingRepoStep(false);
      return;
    }
    if (showRepoPicker) {
      handleToggleRepoPicker();
      return;
    }
    onClose();
  };

  const createRepository = async () => {
    if (!selectedInstallation || !validRepositoryName(repositoryName) || !handleCreateRepository)
      return;
    try {
      await handleCreateRepository(selectedInstallation.installationId, repositoryName);
      setCreatingRepoStep(false);
      setRepositoryName('');
    } catch {
      // The parent keeps the creation error visible in this step.
    }
  };

  const step = creatingRepoStep ? 'create' : showRepoPicker ? 'picker' : 'form';
  const title =
    step === 'create'
      ? 'Create repository'
      : step === 'picker'
        ? 'Repository'
        : `New ${ROOM_LABEL}`;
  const submitDisabled =
    step === 'create'
      ? !selectedInstallation || !validRepositoryName(repositoryName) || creatingRepository
      : !validRoomSlug(roomName) || creatingRoom || creatingRepository;

  return (
    <HullActionSheetModal
      dismissOnBackdrop={!creatingRoom && !creatingRepository}
      onClose={closeStep}
      scrollBody={step !== 'picker'}
      navigation={
        step === 'create' ? (
          <TouchableOpacity
            accessibilityRole="button"
            disabled={creatingRepository}
            onPress={() => setCreatingRepoStep(false)}
            style={styles.backRow}
            testID="create-repository-back"
          >
            <ChevronGlyph color={styles.chevron.color} direction="left" size={CHEVRON_ROW_SIZE} />
            <Text style={styles.backText}>Repository</Text>
          </TouchableOpacity>
        ) : undefined
      }
      testID="new-room-dialog"
      title={title}
      visible={visible}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={creatingRoom || creatingRepository}
            onPress={closeStep}
            style={styles.cancelAction}
            testID="create-room-cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          {step !== 'picker' && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{
                busy: creatingRoom || creatingRepository,
                disabled: submitDisabled,
              }}
              disabled={submitDisabled}
              onPress={() => (step === 'create' ? void createRepository() : void createRoom())}
              style={[styles.primaryAction, submitDisabled && styles.disabledAction]}
              testID={step === 'create' ? 'create-repository-submit' : 'create-room-submit'}
            >
              <Text style={styles.primaryActionText}>
                {step === 'create'
                  ? creatingRepository
                    ? 'Creating…'
                    : 'Create'
                  : creatingRoom
                    ? 'Creating…'
                    : 'Create Room'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      }
    >
      {step === 'form' && (
        <View style={styles.form} testID="create-room-content">
          <View style={styles.roomNameField}>
            <Text style={styles.fieldLabel}>Name</Text>
            <HullDialogInput
              accessibilityLabel={`${ROOM_LABEL} name`}
              editable={!creatingRoom}
              onChangeText={setRoomName}
              onSubmitEditing={() => void createRoom()}
              placeholder="room-name"
              testID="create-room-name"
              value={roomName}
            />
            {roomName.length > 0 && !validRoomSlug(roomName) && (
              <Text testID="create-room-name-hint" style={styles.hint}>
                {ROOM_SLUG_HINT}
              </Text>
            )}
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={creatingRoom}
            onPress={handleToggleRepoPicker}
            style={styles.row}
            testID="create-room-repo-row"
          >
            <Text style={styles.rowLabel}>Repository</Text>
            <Text numberOfLines={1} style={styles.rowValue}>
              {pendingRepo?.name ?? 'None'}
            </Text>
            <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
          </TouchableOpacity>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Public Room</Text>
            <Switch
              accessibilityLabel="Public Room"
              disabled={creatingRoom}
              onValueChange={(value) => setInviteOnly(!value)}
              testID="create-room-public"
              thumbColor={theme.buzz.textPrimary}
              trackColor={{ false: theme.buzz.bgRaised, true: theme.buzz.accent }}
              value={!inviteOnly}
            />
          </View>
        </View>
      )}
      {step === 'picker' && (
        <View style={styles.picker} testID="create-room-picker">
          <View style={styles.pickerContent}>
            <RepoPicker
              candidates={repoCandidates}
              currentKey={pendingRepo?.key ?? null}
              error={repoPickerError}
              installations={repoInstallations}
              notice={repoPickerNotice}
              onAddAccount={handleAddGitHubAccount}
              onManageInstallation={handleManageGitHubInstallation}
              onCreateRepository={handleCreateRepository}
              onStartCreateRepository={() => {
                Keyboard.dismiss();
                setInstallationId(activeInstallations[0]?.installationId ?? null);
                setCreatingRepoStep(true);
              }}
              onSelect={handleSelectRepoCandidate}
              onSelectNoRepository={handleSelectNoRepository}
              noRepositoryInset={HULL_SHEET_INSET}
              testIDPrefix="create-room-repo-picker"
            />
          </View>
        </View>
      )}
      {step === 'create' && (
        <View style={styles.createForm} testID="create-repository-content">
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setChoosingAccount((current) => !current)}
            style={styles.row}
            testID="create-repository-account"
          >
            <Text style={styles.rowLabel}>GitHub account</Text>
            <Text numberOfLines={1} style={styles.rowValue}>
              {selectedInstallation?.accountLogin ?? 'None'}
            </Text>
            <ChevronGlyph
              color={styles.chevron.color}
              direction={choosingAccount ? 'down' : 'right'}
              size={CHEVRON_ROW_SIZE}
            />
          </TouchableOpacity>
          {choosingAccount &&
            activeInstallations.map((installation) => (
              <TouchableOpacity
                accessibilityRole="button"
                key={installation.installationId}
                onPress={() => {
                  setInstallationId(installation.installationId);
                  setChoosingAccount(false);
                }}
                style={styles.row}
                testID={`create-repository-account-${installation.installationId}`}
              >
                <Text style={styles.rowLabel}>{installation.accountLogin}</Text>
                {selectedInstallation?.installationId === installation.installationId && (
                  <Text style={styles.selectedMark}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          <View style={styles.nameField}>
            <Text style={styles.fieldLabel}>Repository name</Text>
            <HullDialogInput
              accessibilityLabel="Repository name"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!creatingRepository}
              onChangeText={setRepositoryName}
              placeholder="repository-name"
              testID="create-repository-name"
              value={repositoryName}
            />
            <Text style={styles.hint}>New repositories are private on GitHub.</Text>
          </View>
          {!!repoPickerError && (
            <Text accessibilityRole="alert" style={styles.error} testID="create-repository-error">
              {repoPickerError}
            </Text>
          )}
        </View>
      )}
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    form: { paddingTop: 4 },
    roomNameField: { paddingHorizontal: HULL_SHEET_INSET, paddingBottom: 16 },
    fieldLabel: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
    },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginTop: 6,
    },
    row: {
      minHeight: 54,
      paddingHorizontal: HULL_SHEET_INSET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    rowLabel: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary, flex: 1 },
    rowValue: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      maxWidth: '50%',
      flexShrink: 1,
    },
    chevron: { color: hull.chrome },
    selectedMark: { ...hull.type.body, color: hull.accent },
    backRow: {
      minHeight: 32,
      paddingHorizontal: HULL_SHEET_INSET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    backText: { ...Typography.default(), ...hull.type.meta, color: hull.chrome },
    picker: { paddingBottom: 8 },
    pickerContent: { paddingHorizontal: HULL_SHEET_INSET, flexShrink: 1 },
    createForm: { paddingBottom: 12 },
    nameField: { paddingHorizontal: HULL_SHEET_INSET, paddingTop: 16 },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginHorizontal: HULL_SHEET_INSET,
      marginTop: 12,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    cancelAction: { minHeight: 44, flex: 1, justifyContent: 'center', alignItems: 'center' },
    cancelText: { ...Typography.default(), ...hull.type.body, color: hull.chrome },
    primaryAction: {
      minHeight: 44,
      minWidth: 118,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      backgroundColor: hull.accent,
    },
    disabledAction: { opacity: 0.42 },
    primaryActionText: { ...Typography.default('semiBold'), color: hull.textInverted },
  };
});
