import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import { githubFullNameFromInput, type RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, validRoomSlug } from '@/buzz/room-name';
import { Typography } from '@/constants/Typography';
import { HullDialogInput } from './HullDialog';
import { HullActionSheetModal, HULL_SHEET_INSET } from './HullActionSheet';
import { RepoPicker } from './RepoPicker';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

type RepoMode = 'none' | 'link' | 'create';

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
  handleManageGitHubInstallation?: (installation: GitHubInstallationAccess) => void;
  handleCreateRepository?: (installationId: number, name: string) => Promise<RepoCandidate>;
};

const MODES: { mode: RepoMode; label: string }[] = [
  { mode: 'none', label: 'None' },
  { mode: 'link', label: 'Link' },
  { mode: 'create', label: 'Create' },
];

/** The two-line repository row keeps one height in every mode so Create Room never moves. */
const REPO_SLOT_HEIGHT = 64;
const OWNER_ROW_HEIGHT = 44;
const OWNER_MENU_MAX_ROWS = 4;

function repoFullName(candidate: RepoCandidate): string | null {
  return (
    githubFullNameFromInput(candidate.name) ??
    (candidate.remote ? githubFullNameFromInput(candidate.remote) : null)
  );
}

function splitFullName(candidate: RepoCandidate): { owner: string | null; name: string } {
  const full = repoFullName(candidate);
  if (!full) return { owner: null, name: candidate.name };
  const [owner, name] = full.split('/');
  return { owner: owner ?? null, name: name ?? candidate.name };
}

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
  handleManageGitHubInstallation,
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

  const busy = creatingRoom || creatingRepository;
  const activeInstallations = repoInstallations.filter((item) => item.status === 'active');
  const selectedInstallation =
    activeInstallations.find((item) => item.installationId === installationId) ??
    activeInstallations[0];
  const slug = roomName.trim();
  const sameName = (candidate: RepoCandidate, owner?: string) => {
    const parts = splitFullName(candidate);
    return (
      parts.name.toLowerCase() === slug.toLowerCase() &&
      (!owner || parts.owner?.toLowerCase() === owner.toLowerCase())
    );
  };
  const nameMatch = slug ? (repoCandidates.find((candidate) => sameName(candidate)) ?? null) : null;
  const takenRepo =
    slug && selectedInstallation
      ? (repoCandidates.find((candidate) =>
          sameName(candidate, selectedInstallation.accountLogin),
        ) ?? null)
      : null;
  const githubConnected = activeInstallations.length > 0;

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

  const connectRow = (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={busy || !handleAddGitHubAccount}
      onPress={handleAddGitHubAccount}
      style={styles.slotRow}
      testID="create-room-github-connect"
    >
      <Text style={styles.rowLabel}>GitHub</Text>
      <Text style={styles.rowValue}>Connect</Text>
      <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
    </TouchableOpacity>
  );

  const loadingRow = (
    <View style={styles.slotRow} testID="create-room-repo-loading">
      <Text style={styles.quiet}>Loading GitHub…</Text>
    </View>
  );

  const linkRow = () => {
    const parts = pendingRepo ? splitFullName(pendingRepo) : null;
    return (
      <TouchableOpacity
        accessibilityLabel={
          pendingRepo
            ? `Linked repository ${repoFullName(pendingRepo) ?? pendingRepo.name}`
            : 'Choose a repo'
        }
        accessibilityRole="button"
        disabled={busy}
        onPress={handleToggleRepoPicker}
        style={styles.slotRow}
        testID="create-room-repo-link"
      >
        <View style={styles.twoLine}>
          <Text numberOfLines={1} style={styles.ownerLine}>
            {parts?.owner ?? 'Repository'}
          </Text>
          <Text numberOfLines={1} style={[styles.nameLine, !parts && styles.placeholderName]}>
            {parts?.name ?? 'Choose a repo'}
          </Text>
        </View>
        <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
      </TouchableOpacity>
    );
  };

  const createRow = () => (
    <View style={[styles.slotRow, takenRepo && styles.takenRow]} testID="create-room-repo-create">
      <View style={styles.twoLine}>
        <View style={styles.ownerLineRow}>
          <TouchableOpacity
            accessibilityLabel={`Owner ${selectedInstallation?.accountLogin ?? ''}, change`}
            accessibilityRole="button"
            accessibilityState={{ expanded: ownerMenuOpen }}
            disabled={busy}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            onPress={() => setOwnerMenuOpen((open) => !open)}
            style={styles.ownerChip}
            testID="create-room-repo-owner"
          >
            <Text numberOfLines={1} style={styles.ownerChipText}>
              {selectedInstallation?.accountLogin}
            </Text>
            <ChevronGlyph
              color={styles.chevron.color}
              direction={ownerMenuOpen ? 'up' : 'down'}
              size={12}
            />
          </TouchableOpacity>
          {takenRepo && (
            <TouchableOpacity
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              onPress={() => linkInstead(takenRepo)}
              testID="create-room-repo-link-instead"
            >
              <Text style={styles.takenText}>
                Exists · <Text style={styles.takenAction}>Link it instead</Text>
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <Text numberOfLines={1} style={[styles.nameLine, styles.followedName]}>
          {slug || 'room-name'}
        </Text>
      </View>
    </View>
  );

  const ownerMenu = (
    <View style={styles.ownerMenu} testID="create-room-owner-menu">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{ maxHeight: OWNER_ROW_HEIGHT * OWNER_MENU_MAX_ROWS }}
      >
        {activeInstallations.map((installation) => (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{
              selected: installation.installationId === selectedInstallation?.installationId,
            }}
            key={installation.installationId}
            onPress={() => {
              setInstallationId(installation.installationId);
              setOwnerMenuOpen(false);
            }}
            style={styles.ownerMenuRow}
            testID={`create-room-owner-${installation.installationId}`}
          >
            <Text numberOfLines={1} style={styles.rowLabel}>
              {installation.accountLogin}
            </Text>
            {installation.installationId === selectedInstallation?.installationId && (
              <Text style={styles.selectedMark}>✓</Text>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
      {handleAddGitHubAccount && (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            setOwnerMenuOpen(false);
            handleAddGitHubAccount();
          }}
          style={[styles.ownerMenuRow, styles.ownerMenuConnect]}
          testID="create-room-owner-connect"
        >
          <Text style={styles.connectText}>Connect another org</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const slot = () => {
    if (mode === 'none') {
      return (
        <View style={styles.slotRow} testID="create-room-repo-none">
          <Text style={styles.quiet}>No repository. You can link one later.</Text>
        </View>
      );
    }
    if (!githubConnected) return repoAccessLoading ? loadingRow : connectRow;
    return mode === 'link' ? linkRow() : createRow();
  };

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
      title={step === 'picker' ? 'Link a repository' : `New ${ROOM_LABEL}`}
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
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: submitDisabled }}
              disabled={submitDisabled}
              onPress={() => void submit()}
              style={[styles.primaryAction, submitDisabled && styles.disabledAction]}
              testID="create-room-submit"
            >
              <Text style={styles.primaryActionText}>{busy ? 'Creating…' : 'Create Room'}</Text>
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
              editable={!busy}
              onChangeText={setRoomName}
              onSubmitEditing={() => {
                if (!submitDisabled) void submit();
              }}
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
          {revealed ? (
            <View style={styles.repoBlock}>
              <View style={styles.segments} testID="create-room-repo-mode">
                {MODES.map(({ mode: option, label }) => (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{ selected: mode === option, disabled: busy }}
                    disabled={busy}
                    key={option}
                    onPress={() => chooseMode(option)}
                    style={[styles.segment, mode === option && styles.segmentSelected]}
                    testID={`create-room-repo-mode-${option}`}
                  >
                    <Text
                      style={[styles.segmentText, mode === option && styles.segmentTextSelected]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.slot}>
                {ownerMenuOpen && mode === 'create' && githubConnected && ownerMenu}
                {slot()}
              </View>
              {mode !== 'none' && !!repoPickerError && (
                <Text
                  accessibilityRole="alert"
                  style={styles.error}
                  testID="create-room-repo-error"
                >
                  {repoPickerError}
                </Text>
              )}
              {mode !== 'none' && !repoPickerError && !!repoPickerNotice && (
                <Text accessibilityLiveRegion="polite" style={styles.hint}>
                  {repoPickerNotice}
                </Text>
              )}
            </View>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy}
              onPress={reveal}
              style={styles.row}
              testID="create-room-repo-row"
            >
              <Text style={styles.rowLabel}>Repository</Text>
              <Text numberOfLines={1} style={styles.rowValue}>
                None
              </Text>
              <ChevronGlyph
                color={styles.chevron.color}
                direction="right"
                size={CHEVRON_ROW_SIZE}
              />
            </TouchableOpacity>
          )}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Public</Text>
            <Switch
              accessibilityLabel="Public Room"
              disabled={busy}
              onValueChange={(value) => setInviteOnly(!value)}
              testID="create-room-public"
              thumbColor={theme.buzz.bgBase}
              {...(Platform.OS === 'web' ? { activeThumbColor: theme.buzz.bgBase } : {})}
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
              draftContext={draftContext}
              busy={repoAccessLoading && repoCandidates.length === 0}
              candidates={repoCandidates}
              currentKey={pendingRepo?.key ?? null}
              error={repoPickerError}
              installations={repoInstallations}
              notice={repoPickerNotice}
              onAddAccount={handleAddGitHubAccount}
              onManageInstallation={handleManageGitHubInstallation}
              onSelect={(candidate) => {
                setLinkPicked(true);
                handleSelectRepoCandidate(candidate);
              }}
              testIDPrefix="create-room-repo-picker"
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
      marginHorizontal: HULL_SHEET_INSET,
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
    repoBlock: {
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: 12,
      paddingBottom: 12,
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    segments: {
      flexDirection: 'row',
      minHeight: 44,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
      overflow: 'hidden',
    },
    segment: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    segmentSelected: { backgroundColor: hull.bgHighlight },
    segmentText: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    segmentTextSelected: { color: hull.textPrimary },
    // The owner menu hangs above the row it changes and covers the switch.
    slot: { position: 'relative', zIndex: 2 },
    slotRow: {
      height: REPO_SLOT_HEIGHT,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    takenRow: { borderColor: hull.warning },
    twoLine: { flex: 1, minWidth: 0, gap: 2 },
    ownerLineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    ownerLine: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    ownerChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      flexShrink: 1,
    },
    ownerChipText: {
      ...Typography.default('semiBold'),
      ...hull.type.meta,
      color: hull.accent,
      flexShrink: 1,
    },
    takenText: { ...Typography.default(), ...hull.type.meta, color: hull.warning },
    takenAction: { textDecorationLine: 'underline' },
    nameLine: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    placeholderName: { color: hull.textMuted },
    followedName: { color: hull.textSecondary },
    quiet: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, flex: 1 },
    ownerMenu: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: REPO_SLOT_HEIGHT - 1,
      zIndex: 3,
      elevation: 3,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
      backgroundColor: hull.bgRaised,
    },
    ownerMenuRow: {
      minHeight: OWNER_ROW_HEIGHT,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    ownerMenuConnect: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hull.border },
    connectText: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    picker: { paddingBottom: 8 },
    pickerContent: { paddingHorizontal: HULL_SHEET_INSET, flexShrink: 1 },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
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
    cancelText: { ...Typography.default(), ...hull.type.body, color: hull.buttonSecondaryText },
    primaryAction: {
      minHeight: 44,
      minWidth: 118,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      backgroundColor: hull.buttonPrimaryFill,
    },
    disabledAction: { opacity: 0.42 },
    primaryActionText: { ...Typography.default('semiBold'), color: hull.buttonPrimaryText },
  };
});
