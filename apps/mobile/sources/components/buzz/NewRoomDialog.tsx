import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, Switch, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, validRoomSlug } from '@/buzz/room-name';
import { Typography } from '@/constants/Typography';
import { Button } from './Button';
import { HullDialogInput } from './HullDialog';
import { HullActionSheetModal, HULL_SHEET_INSET } from './HullActionSheet';
import { RepoList } from './RepoList';
import {
  RepositoryChoice,
  repositoryChoiceFacts,
  useSelectConnectedOwner,
  type RepoMode,
} from './RepositoryChoice';

type Props = {
  visible: boolean;
  draftContext?: string;
  roomName: string;
  setRoomName: (name: string) => void;
  inviteOnly: boolean;
  setInviteOnly: (value: boolean) => void;
  creatingRoom: boolean;
  creatingRepository?: boolean;
  /** Creates the Room linked to `repository`, or to none. */
  createRoom: (repository: RepoCandidate | null) => void;
  onClose: () => void;
  pendingRepo: RepoCandidate | null;
  /** The "Link a repository" list is open. */
  showRepoPicker: boolean;
  handleToggleRepoPicker: () => void;
  /** Read the viewer's GitHub installations and repositories. */
  handleLoadRepositories?: () => void;
  repoAccessLoading?: boolean;
  handleSelectNoRepository: () => void;
  handleSelectRepoCandidate: (repo: RepoCandidate) => void;
  repoCandidates: RepoCandidate[];
  repoInstallations: GitHubInstallationAccess[];
  repoPickerError: string | null;
  repoPickerNotice?: string | null;
  handleAddGitHubAccount?: () => void;
  handleCreateRepository?: (installationId: number, name: string) => Promise<RepoCandidate>;
};

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
  handleLoadRepositories,
  repoAccessLoading = false,
  handleSelectNoRepository,
  handleSelectRepoCandidate,
  repoCandidates,
  repoInstallations,
  repoPickerError,
  repoPickerNotice,
  handleAddGitHubAccount,
  handleCreateRepository,
  draftContext = 'global',
}: Props) {
  const { theme } = useUnistyles();
  const [revealed, setRevealed] = useState(false);
  const [mode, setMode] = useState<RepoMode>('none');
  // Link follows the room name until the user picks a repository themselves.
  const [linkPicked, setLinkPicked] = useState(false);
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const wasVisible = useRef(false);

  const trackConnect = useSelectConnectedOwner(repoInstallations, setInstallationId);
  const busy = creatingRoom || creatingRepository;
  const slug = roomName.trim();
  const { activeInstallations, selectedInstallation, nameMatch, takenRepo, githubConnected } =
    repositoryChoiceFacts({
      name: slug,
      candidates: repoCandidates,
      installations: repoInstallations,
      installationId,
    });

  const reveal = () => {
    Keyboard.dismiss();
    setRevealed(true);
    handleLoadRepositories?.();
  };

  // Each opening starts from the parent's repository choice; a cold resume
  // from the GitHub install lands back on the Link list.
  useEffect(() => {
    if (visible && !wasVisible.current) {
      const linking = Boolean(pendingRepo) || showRepoPicker;
      setMode(linking ? 'link' : 'none');
      setLinkPicked(Boolean(pendingRepo));
      setRevealed(linking);
      setOwnerMenuOpen(false);
      if (linking) handleLoadRepositories?.();
    }
    wasVisible.current = visible;
  }, [handleLoadRepositories, pendingRepo, showRepoPicker, visible]);

  useEffect(() => {
    if (mode !== 'link' || linkPicked || showRepoPicker) return;
    if ((nameMatch?.key ?? null) === (pendingRepo?.key ?? null)) return;
    if (nameMatch) handleSelectRepoCandidate(nameMatch);
    else handleSelectNoRepository();
  }, [
    handleSelectNoRepository,
    handleSelectRepoCandidate,
    linkPicked,
    mode,
    nameMatch,
    pendingRepo,
    showRepoPicker,
  ]);

  const chooseMode = (next: RepoMode) => {
    setOwnerMenuOpen(false);
    if (next === mode) return;
    setMode(next);
    setLinkPicked(false);
    if (next === 'none' || next === 'create') {
      if (pendingRepo) handleSelectNoRepository();
      // A new repository is private, so its Room starts invite-only.
      setInviteOnly(next === 'create');
    }
  };

  const linkInstead = (repo: RepoCandidate) => {
    setOwnerMenuOpen(false);
    setMode('link');
    setLinkPicked(true);
    handleSelectRepoCandidate(repo);
  };

  const submit = async () => {
    if (mode === 'none') return createRoom(null);
    if (mode === 'link') return createRoom(pendingRepo);
    if (!selectedInstallation || !handleCreateRepository) return;
    let repository: RepoCandidate;
    try {
      repository = await handleCreateRepository(selectedInstallation.installationId, slug);
    } catch {
      // The parent keeps the creation error visible under the row.
      return;
    }
    // The repository now exists; a retry after a failed Room creation links it.
    setMode('link');
    setLinkPicked(true);
    createRoom(repository);
  };

  const step = showRepoPicker ? 'picker' : 'form';
  const submitDisabled =
    !validRoomSlug(slug) ||
    busy ||
    (mode === 'link' && !pendingRepo) ||
    (mode === 'create' && (!selectedInstallation || !handleCreateRepository || !!takenRepo));

  return (
    <HullActionSheetModal
      dismissOnBackdrop={!busy}
      onClose={() => {
        if (busy) return;
        if (showRepoPicker) handleToggleRepoPicker();
        else onClose();
      }}
      scrollBody={step !== 'picker'}
      testID="new-room-dialog"
      title={step === 'picker' ? 'Choose a repo' : `New ${ROOM_LABEL}`}
      visible={visible}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy}
            onPress={() => (showRepoPicker ? handleToggleRepoPicker() : onClose())}
            style={styles.cancelAction}
            testID="create-room-cancel"
          >
            <Text style={styles.cancelText}>{showRepoPicker ? 'Back' : 'Cancel'}</Text>
          </TouchableOpacity>
          {step === 'form' && (
            <Button
              disabled={submitDisabled}
              label={busy ? 'Creating…' : 'Create Room'}
              loading={busy}
              onPress={() => void submit()}
              style={styles.primaryAction}
              testID="create-room-submit"
            />
          )}
        </View>
      }
    >
      {step === 'form' && (
        <View style={styles.form} testID="create-room-content">
          <View style={styles.roomNameField}>
            <HullDialogInput
              accessibilityLabel={`${ROOM_LABEL} name`}
              ruleStyle={styles.nameRule}
              editable={!busy}
              onChangeText={setRoomName}
              onSubmitEditing={() => {
                if (!submitDisabled) void submit();
              }}
              placeholder="Name"
              testID="create-room-name"
              value={roomName}
            />
            {roomName.length > 0 && !validRoomSlug(roomName) && (
              <Text testID="create-room-name-hint" style={styles.hint}>
                {ROOM_SLUG_HINT}
              </Text>
            )}
          </View>
          {revealed ? (
            <RepositoryChoice
              activeInstallations={activeInstallations}
              busy={busy}
              createName={slug}
              error={mode !== 'none' ? repoPickerError : null}
              githubConnected={githubConnected}
              linkRepo={pendingRepo}
              loading={repoAccessLoading}
              mode={mode}
              notice={repoPickerNotice}
              onChooseMode={chooseMode}
              onConnect={trackConnect(handleAddGitHubAccount)}
              onLinkInstead={linkInstead}
              onOpenList={handleToggleRepoPicker}
              onSelectInstallation={setInstallationId}
              ownerMenuOpen={ownerMenuOpen}
              selectedInstallation={selectedInstallation}
              setOwnerMenuOpen={setOwnerMenuOpen}
              takenRepo={takenRepo}
              testIDPrefix="create-room"
            />
          ) : (
            // Flat, matching Name's hairline rule and the Public row below —
            // no box. Kept local (not HullActionSheetRow) so it stays inside
            // `styles.form`'s own 24px inset instead of doubling it.
            <TouchableOpacity
              accessibilityLabel="Repository None, change"
              accessibilityRole="button"
              disabled={busy}
              onPress={reveal}
              style={styles.fieldRow}
              testID="create-room-repo-row"
            >
              <Text style={styles.fieldLabel}>Repository</Text>
              <Text style={styles.fieldValue}>None</Text>
            </TouchableOpacity>
          )}
          <View style={styles.fieldRow} testID="create-room-public-row">
            <Text style={styles.fieldLabel}>Public</Text>
            <Switch
              accessibilityLabel="Public Room"
              disabled={busy}
              onValueChange={(value) => setInviteOnly(!value)}
              testID="create-room-public"
              thumbColor={theme.buzz.bgBase}
              {...(Platform.OS === 'web' ? { activeThumbColor: theme.buzz.bgBase } : {})}
              trackColor={{ false: theme.buzz.borderStrong, true: theme.buzz.accent }}
              value={!inviteOnly}
            />
          </View>
        </View>
      )}
      {step === 'picker' && (
        <View style={styles.picker} testID="create-room-picker">
          <View style={styles.pickerContent}>
            <RepoList
              candidates={repoCandidates}
              currentKey={pendingRepo?.key ?? null}
              draftContext={draftContext}
              loading={repoAccessLoading}
              onSelect={(candidate) => {
                setLinkPicked(true);
                handleSelectRepoCandidate(candidate);
              }}
              testIDPrefix="create-room-repo-list"
            />
          </View>
        </View>
      )}
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    form: { paddingHorizontal: HULL_SHEET_INSET, paddingTop: hull.space.xs },
    roomNameField: { paddingBottom: hull.space.md },
    nameRule: { marginTop: 0 },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginTop: hull.space.sm,
    },
    // Shared by the Repository and Public rows below: same label weight and
    // row rhythm as Name's hairline rule, so the three fields read as one
    // list instead of Repository standing out in its own box.
    fieldLabel: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      flex: 1,
      fontFamily: hull.proseRegular,
    },
    fieldValue: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      fontFamily: hull.proseRegular,
    },
    fieldRow: {
      minHeight: 52,
      paddingVertical: hull.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
    },
    picker: { paddingBottom: 8 },
    pickerContent: { paddingHorizontal: HULL_SHEET_INSET, flexShrink: 1 },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: hull.space.xs,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: hull.space.sm,
    },
    cancelAction: {
      minHeight: 42,
      paddingHorizontal: hull.space.sm,
      justifyContent: 'center',
    },
    cancelText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    primaryAction: { minHeight: 42, paddingHorizontal: hull.space.md },
  };
});
