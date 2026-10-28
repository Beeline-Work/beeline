import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { InlineRow } from './IndexRow';
import { HullActionSheetRow } from './HullActionSheet';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { memo, useMemo, useState } from 'react';
import { SectionList, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { GitHubRepositoryLinkagePlan, RepoCandidate } from '@/buzz/room-repo-picker';
import {
  explainMissingRepo,
  filterRepoCandidates,
  GITHUB_REPOSITORY_SELECTION_INSTRUCTION,
  githubFullNameFromInput,
  githubRepositoryLinkagePlan,
  groupRepoCandidatesByOwner,
  repoShortName,
} from '@/buzz/room-repo-picker';
import { OwnerGrantNeededCard, type OwnerGrantNeeded } from './OwnerGrantNeededCard';
import { Typography } from '@/constants/Typography';

export type RepoPickerProps = {
  candidates: RepoCandidate[];
  installations?: GitHubInstallationAccess[];
  currentKey?: string | null;
  busy?: boolean;
  error?: string | null;
  fillAvailableHeight?: boolean;
  notice?: string | null;
  /**
   * A typed pending state: the chosen repository is not covered by the App
   * yet, and only its owner can grant access. Rendered as a share CTA, never
   * as an error.
   */
  ownerGrant?: OwnerGrantNeeded | null;
  onSelect: (candidate: RepoCandidate) => void;
  onSelectNoRepository?: () => void;
  noRepositoryInset?: number;
  onAddAccount?: (owner?: string) => void;
  onManageInstallation?: (installation: GitHubInstallationAccess) => void;
  onCreateRepository?: (installationId: number, name: string) => Promise<void> | void;
  /** Open a host-owned creation step instead of the picker's inline editor. */
  onStartCreateRepository?: () => void;
  /** Present only when the current viewer may unlink a bound Room repository. */
  onUnlink?: () => void;
  unlinkRepositoryName?: string | null;
  /**
   * The pasted repository's OWNER is not among this viewer's installations:
   * offer the share-with-owner path (the host probes the typed grant state
   * and shares the install link). Absent keeps the connect-only flow.
   */
  onAskOwnerGrant?: (fullName: string) => void;
  /** Owners the server has already reported as never covered (`owner_grant_needed`). */
  uncoveredOwners?: ReadonlySet<string>;
  testIDPrefix?: string;
  draftContext?: string;
};

/**
 * The candidate list is height-bounded and internally scrollable so an
 * account with 100+ repositories never renders past the fold: every host
 * (room-create panel, corner-open banner, Room-actions sheet) constrains it
 * to about six sheet rows.
 */
export const REPO_CANDIDATE_ROW_MIN_HEIGHT = 52;
export const REPO_CANDIDATE_VISIBLE_ROWS = 6;
export const REPO_CANDIDATE_LIST_MAX_HEIGHT =
  REPO_CANDIDATE_ROW_MIN_HEIGHT * REPO_CANDIDATE_VISIBLE_ROWS;

export const RepoPicker = memo(function RepoPicker({
  candidates,
  installations = [],
  currentKey,
  busy = false,
  error,
  fillAvailableHeight = false,
  notice,
  ownerGrant,
  onSelect,
  onSelectNoRepository,
  noRepositoryInset = 0,
  onAddAccount,
  onManageInstallation,
  onCreateRepository,
  onStartCreateRepository,
  onUnlink,
  unlinkRepositoryName,
  onAskOwnerGrant,
  uncoveredOwners,
  testIDPrefix = 'repo-picker',
  draftContext = 'global',
}: RepoPickerProps) {
  const { theme } = useUnistyles();
  const groknight = theme.buzz;
  const [query, setQuery] = useTextDraft(`repo-search:${draftContext}:${testIDPrefix}`, '');
  const [creating, setCreating] = useState(false);
  const [createInstallationId, setCreateInstallationId] = useState<number | null>(null);
  const [newName, setNewName, repositoryDraft] = useTextDraft(
    `repo-create:${draftContext}:${testIDPrefix}:${createInstallationId ?? 'default'}`,
    '',
  );
  const [pendingLinkage, setPendingLinkage] = useState<Exclude<
    GitHubRepositoryLinkagePlan,
    { kind: 'available' }
  > | null>(null);
  const visible = useMemo(
    () => filterRepoCandidates(candidates, query, installations),
    [candidates, query, installations],
  );
  const activeInstallations = installations.filter(
    (installation) => installation.status === 'active',
  );
  const sections = useMemo(() => {
    const loginByOwner = new Map(
      installations.map((installation) => [installation.accountLogin.toLowerCase(), installation]),
    );
    return groupRepoCandidatesByOwner(visible).map((group) => ({
      key: group.owner ? `owner-${group.owner.toLowerCase()}` : 'ungrouped',
      owner: group.owner,
      installation: group.owner ? (loginByOwner.get(group.owner.toLowerCase()) ?? null) : null,
      data: group.data,
    }));
  }, [installations, visible]);
  // Headings are the repository owner. One GitHub App installation can grant
  // repos from several owners; grouping by installationId parked those under
  // the install account. Search already dropped empty groups.
  const pastedFullName = githubFullNameFromInput(query);
  const showLoadingPlaceholders = busy && visible.length === 0 && !error && !pastedFullName;
  const exactCandidate = pastedFullName
    ? candidates.find((candidate) => candidate.name.toLowerCase() === pastedFullName.toLowerCase())
    : undefined;
  const pastedOwner = pastedFullName?.split('/')[0];
  const ownerInstallation = pastedOwner
    ? installations.find(
        (installation) =>
          installation.status === 'active' &&
          installation.accountLogin.toLowerCase() === pastedOwner.toLowerCase(),
      )
    : undefined;
  // Named a repository that is not in the list? Say why before the user
  // decides Beeline simply lost it — an org repo is usually one grant away.
  const missing = useMemo(
    () =>
      pastedFullName && !exactCandidate
        ? explainMissingRepo(pastedFullName, candidates, installations, { uncoveredOwners })
        : null,
    [candidates, exactCandidate, installations, pastedFullName, uncoveredOwners],
  );

  const candidateRow = (candidate: RepoCandidate, owner: string | null) => (
    <HullActionSheetRow
      accessibilityLabel={candidate.name}
      disabled={busy}
      key={candidate.key}
      label={repoShortName(candidate, owner)}
      selected={candidate.key === currentKey}
      onPress={() => onSelect(candidate)}
      testID={`${testIDPrefix}-candidate-${candidate.key}`}
    />
  );

  return (
    <View
      style={[styles.container, fillAvailableHeight && styles.containerFill]}
      testID={testIDPrefix}
    >
      <HullDialogInput
        accessibilityLabel="Search repositories or paste a GitHub URL"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        onChangeText={(value) => {
          setQuery(value);
          setPendingLinkage(null);
        }}
        placeholder="Search or paste owner/repo"
        placeholderTextColor={groknight.dim}
        variant="sheetSearch"
        value={query}
      />
      {onSelectNoRepository && (
        <View style={{ marginHorizontal: -noRepositoryInset }}>
          <HullActionSheetRow
            label="No repository"
            selected={!currentKey}
            onPress={onSelectNoRepository}
            testID={`${testIDPrefix}-no-repository`}
          />
        </View>
      )}
      {ownerGrant && <OwnerGrantNeededCard {...ownerGrant} />}
      <SectionList
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          showLoadingPlaceholders ? (
            <View accessibilityLabel="Loading repositories" testID={`${testIDPrefix}-loading`}>
              {Array.from({ length: REPO_CANDIDATE_VISIBLE_ROWS }, (_, index) => (
                <InlineRow
                  key={index}
                  style={styles.placeholderRow}
                  testID={`${testIDPrefix}-placeholder-${index}`}
                >
                  <View style={styles.placeholderBar} />
                </InlineRow>
              ))}
            </View>
          ) : !error && !pastedFullName ? (
            <EmptyState title="No repositories match." />
          ) : null
        }
        nestedScrollEnabled
        renderItem={({ item, section }) => candidateRow(item, section.owner)}
        renderSectionHeader={({ section }) =>
          section.owner ? (
            <InlineRow
              style={styles.groupHeader}
              testID={`${testIDPrefix}-group-${section.owner.toLowerCase()}`}
            >
              <RoomListSectionHeader title={section.owner ?? ''} inset="content" spacing="flush" />
              <Text style={styles.groupMeta}>
                {section.installation && section.installation.status !== 'active'
                  ? section.installation.status.toUpperCase()
                  : `${section.data.length} ${section.data.length === 1 ? 'REPO' : 'REPOS'}`}
              </Text>
            </InlineRow>
          ) : null
        }
        sections={sections}
        style={[
          styles.candidateScroll,
          fillAvailableHeight && styles.candidateScrollFill,
          { maxHeight: REPO_CANDIDATE_LIST_MAX_HEIGHT },
        ]}
        testID={`${testIDPrefix}-list`}
      />
      {pastedFullName && !exactCandidate && (
        <View>
          {missing && <Text style={styles.connectReason} testID={`${testIDPrefix}-missing-reason`}>{missing.message}</Text>}
          <HullActionSheetRow
            label={pastedFullName}
            description={ownerInstallation?.status === 'active'
              ? 'Add this repo to the Beeline installation'
              : `Connect ${pastedOwner}`}
            onPress={() => {
              const plan = githubRepositoryLinkagePlan(pastedFullName, candidates, installations, {
                uncoveredOwners,
              });
              if (plan.kind === 'available') onSelect(plan.candidate);
              else setPendingLinkage(plan);
            }}
            testID={`${testIDPrefix}-connect-card`}
          />
        </View>
      )}
      {pendingLinkage && (
        <View style={styles.instructionCard} testID={`${testIDPrefix}-link-instruction`}>
          <Text style={styles.instructionTitle}>ON GITHUB</Text>
          <Text style={styles.instructionText}>{GITHUB_REPOSITORY_SELECTION_INSTRUCTION}</Text>
          <HullDialogActions style={styles.instructionActions} actions={[{ label: "Cancel", variant: "quiet", onPress: () => setPendingLinkage(null) }, { label: pendingLinkage.kind === 'owner-grant'
                  ? 'Share install link'
                  : 'Continue to GitHub', ...(pendingLinkage.kind === 'owner-grant' ? {} : { destination: 'external' as const }), variant: "primary", onPress: () => {
                const plan = pendingLinkage;
                setPendingLinkage(null);
                if (plan.kind === 'manage') onManageInstallation?.(plan.installation);
                else if (plan.kind === 'owner-grant') onAskOwnerGrant?.(plan.fullName);
                else onAddAccount?.(plan.owner || undefined);
              }, testID: `${testIDPrefix}-link-continue` }]} />
        </View>
      )}
      {onCreateRepository && activeInstallations.length > 0 && (
        <View>
          <HullActionSheetRow
            label="Create repository"
            disabled={busy}
            onPress={() => {
              if (onStartCreateRepository) {
                onStartCreateRepository();
                return;
              }
              setCreating((value) => !value);
              setCreateInstallationId(
                (current) => current ?? activeInstallations[0]!.installationId,
              );
            }}
            testID={`${testIDPrefix}-create-repo`}
          />
          {creating && !onStartCreateRepository && (
            <View style={styles.createForm}>
              <View>
                {activeInstallations.map((installation) => (
                  <HullActionSheetRow
                    key={installation.installationId}
                    label={installation.accountLogin}
                    selected={createInstallationId === installation.installationId}
                    disabled={busy}
                    onPress={() => setCreateInstallationId(installation.installationId)}
                  />
                ))}
              </View>
              <InlineRow style={styles.createRow}>
                <HullDialogInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setNewName}
                  placeholder="repository-name"
                  placeholderTextColor={groknight.dim}
                  style={styles.createInput}
                  value={newName}
                />
                <HullDialogActions actions={[{
                  label: 'CREATE',
                  variant: 'primary',
                  disabled: busy || !createInstallationId || !/^[A-Za-z0-9._-]{1,100}$/.test(newName),
                  onPress: () => {
                    if (!createInstallationId) return;
                    const clearRepository = repositoryDraft.capture();
                    void Promise.resolve(onCreateRepository(createInstallationId, newName))
                      .then(() => {
                        clearRepository();
                        setCreating(false);
                      })
                      .catch(() => undefined);
                  },
                }]} />
              </InlineRow>
            </View>
          )}
        </View>
      )}
      {onAddAccount && (
        <HullActionSheetRow
          label="Add repositories, accounts, or organizations"
          disabled={busy}
          onPress={() => setPendingLinkage({ kind: 'install', owner: '', fullName: '' })}
          testID={`${testIDPrefix}-add-account`}
        />
      )}
      {onUnlink && unlinkRepositoryName ? (
        <HullActionSheetRow
          label="Unlink repo"
          accessibilityLabel={`Unlink repo, currently ${unlinkRepositoryName}`}
          disabled={busy}
          destructive
          onPress={onUnlink}
          testID={`${testIDPrefix}-unlink`}
        />
      ) : null}
      {notice && !error && (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      )}
      {error && (
        <ErrorBanner inline title={`! ${error}`} />
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    container: { flexShrink: 1, minHeight: 0 },
    containerFill: { flex: 1 },
    candidateScroll: {
      // Height-bounded so a 100+ repo account scrolls instead of rendering past
      // the fold; six sheet rows, see REPO_CANDIDATE_LIST_MAX_HEIGHT.
      flexGrow: 0,
    },
    placeholderRow: {
      minHeight: REPO_CANDIDATE_ROW_MIN_HEIGHT,
      justifyContent: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.border,
    },
    placeholderBar: {
      height: StyleSheet.hairlineWidth,
      width: '42%',
      backgroundColor: groknight.border,
    },
    candidateScrollFill: { flex: 1, flexShrink: 1, minHeight: 0 },
    groupHeader: {
      // This SectionList sticks the whole row, including the trailing count.
      backgroundColor: groknight.bgHighlight,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: groknight.space.sm,
      paddingTop: groknight.space.md,
      paddingBottom: groknight.space.xs,
    },
    groupMeta: { ...groknight.type.meta, color: groknight.textMuted },
    // The secondary-caption role, not another raw size (DESIGN.md → Type).
    connectReason: { ...groknight.type.meta, color: groknight.textMuted },
    instructionCard: {
      borderWidth: 1,
      borderColor: groknight.accent,
      padding: groknight.space.md,
      gap: groknight.space.sm,
      marginVertical: 8,
    },
    instructionTitle: { ...groknight.type.sectionHead, fontFamily: groknight.monoRegular, color: groknight.accent },
    instructionText: { ...groknight.type.machine, color: groknight.textPrimary },
    instructionActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: groknight.space.sm,
    },
    createForm: { gap: 8, paddingBottom: groknight.space.md },
    createRow: { flexDirection: 'row', gap: 8 },
    createInput: {
      ...groknight.type.machine,
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      color: groknight.textPrimary,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
    },
    notice: {
      ...groknight.type.machine,
      color: groknight.textMuted,
      paddingTop: 8,
    },
  };
});
