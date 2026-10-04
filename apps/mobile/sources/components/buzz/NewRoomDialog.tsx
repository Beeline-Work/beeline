import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import { githubFullNameFromInput, type RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { ROOM_SLUG_HINT, validRoomSlug } from '@/buzz/room-name';
import { Typography } from '@/constants/Typography';
import { Button } from './Button';
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
      style={styles.boxRow}
      testID="create-room-github-connect"
    >
      <Text style={styles.boxKey}>GitHub</Text>
      <Text style={styles.connectValue}>Connect</Text>
      <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
    </TouchableOpacity>
  );

  const loadingRow = (
    <View style={styles.boxRow} testID="create-room-repo-loading">
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
        style={styles.repoRow}
        testID="create-room-repo-link"
      >
        <View style={styles.twoLine}>
          {parts?.owner && (
            <Text numberOfLines={1} style={styles.ownerLine}>
              {parts.owner}
            </Text>
          )}
          <Text numberOfLines={1} style={[styles.nameLine, !parts && styles.placeholderName]}>
            {parts?.name ?? 'Choose a repo'}
          </Text>
        </View>
        <ChevronGlyph color={styles.chevron.color} direction="right" size={CHEVRON_ROW_SIZE} />
      </TouchableOpacity>
    );
  };

  const createRow = () => (
    <View style={[styles.repoRow, takenRepo && styles.takenRow]} testID="create-room-repo-create">
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
        </View>
        <Text numberOfLines={1} style={[styles.nameLine, !slug && styles.placeholderName]}>
          {slug || 'room-name'}
        </Text>
        {takenRepo && (
          <View style={styles.takenLine}>
            <Text style={styles.takenText}>Already exists.</Text>
            <TouchableOpacity
              accessibilityRole="button"
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              onPress={() => linkInstead(takenRepo)}
              testID="create-room-repo-link-instead"
            >
              <Text style={styles.takenAction}>Link it instead</Text>
            </TouchableOpacity>
          </View>
        )}
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
            style={[
              styles.ownerMenuRow,
              installation.installationId === selectedInstallation?.installationId &&
                styles.ownerMenuSelected,
            ]}
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
            <Text style={styles.fieldLabel}>Name</Text>
            <HullDialogInput
              accessibilityLabel={`${ROOM_LABEL} name`}
              ruleStyle={styles.nameRule}
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
              <Text style={styles.fieldLabel}>Repository</Text>
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
              {mode !== 'none' && (
                <View style={styles.slot}>
                  {ownerMenuOpen && mode === 'create' && githubConnected && ownerMenu}
                  {slot()}
                </View>
              )}
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
              style={[styles.boxRow, styles.collapsedRow]}
              testID="create-room-repo-row"
            >
              <Text style={styles.boxKey}>Repository</Text>
              <Text numberOfLines={1} style={styles.boxValue}>
                None
              </Text>
              <ChevronGlyph
                color={styles.chevron.color}
                direction="right"
                size={CHEVRON_ROW_SIZE}
              />
            </TouchableOpacity>
          )}
          <View style={styles.publicRow}>
            <Text style={styles.boxKey}>Public</Text>
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
    form: { paddingHorizontal: HULL_SHEET_INSET, paddingTop: hull.space.xs },
    roomNameField: { paddingBottom: hull.space.md },
    fieldLabel: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginBottom: hull.space.xs,
    },
    nameRule: { marginTop: 0 },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      marginTop: hull.space.sm,
    },
    rowLabel: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary, flex: 1 },
    chevron: { color: hull.textMuted },
    selectedMark: { ...hull.type.body, color: hull.buttonPrimaryFill },
    // One quiet boxed row: the collapsed Repository choice, GitHub Connect, loading.
    boxRow: {
      minHeight: 46,
      paddingHorizontal: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.xs,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    collapsedRow: { marginBottom: hull.space.xs },
    boxKey: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary, flex: 1 },
    boxValue: { ...Typography.default(), ...hull.type.meta, color: hull.textPrimary },
    connectValue: {
      ...Typography.default('semiBold'),
      ...hull.type.meta,
      color: hull.buttonPrimaryFill,
    },
    repoBlock: { paddingBottom: hull.space.xs },
    segments: {
      flexDirection: 'row',
      padding: hull.space.xs,
      gap: 0,
      backgroundColor: hull.bgBase,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    segment: {
      flex: 1,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
    },
    segmentSelected: { backgroundColor: hull.buttonPrimaryFill },
    segmentText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    segmentTextSelected: {
      ...Typography.default('semiBold'),
      color: hull.buttonPrimaryText,
    },
    // The owner menu hangs above the row it changes and covers the switch.
    slot: { position: 'relative', zIndex: 2, marginTop: hull.space.sm },
    repoRow: {
      paddingTop: hull.space.sm,
      paddingBottom: hull.space.sm,
      paddingHorizontal: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    takenRow: { borderColor: hull.warning },
    twoLine: { flex: 1, minWidth: 0, gap: hull.space.xs },
    ownerLineRow: { flexDirection: 'row', alignItems: 'center' },
    ownerLine: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    ownerChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.xs,
      flexShrink: 1,
      minHeight: 22,
      paddingLeft: hull.space.sm,
      paddingRight: hull.space.xs,
      backgroundColor: hull.bgHighlight,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
    },
    ownerChipText: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textPrimary,
      flexShrink: 1,
    },
    takenLine: { flexDirection: 'row', alignItems: 'center', gap: hull.space.xs },
    takenText: { ...Typography.default(), ...hull.type.meta, color: hull.warning },
    takenAction: {
      ...Typography.default('semiBold'),
      ...hull.type.meta,
      color: hull.buttonPrimaryFill,
      textDecorationLine: 'underline',
    },
    nameLine: {
      ...Typography.default('semiBold'),
      ...hull.type.bodyStrong,
      color: hull.textPrimary,
    },
    placeholderName: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
    quiet: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, flex: 1 },
    ownerMenu: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: '100%',
      marginBottom: hull.space.xs,
      zIndex: 3,
      padding: hull.space.xs,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
      backgroundColor: hull.bgRaised,
    },
    ownerMenuRow: {
      minHeight: OWNER_ROW_HEIGHT,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
    },
    ownerMenuSelected: { backgroundColor: hull.bgHighlight },
    ownerMenuConnect: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hull.border },
    connectText: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    // Public sits in the compact layout as one quiet line, with no divider.
    publicRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
    },
    picker: { paddingBottom: 8 },
    pickerContent: { paddingHorizontal: HULL_SHEET_INSET, flexShrink: 1 },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginTop: hull.space.sm,
    },
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
