import React, { memo, useMemo, useState } from 'react';
import {
  SectionList,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { GitHubRepositoryLinkagePlan, RepoCandidate } from '@/buzz/room-repo-picker';
import {
  filterRepoCandidates,
  GITHUB_REPOSITORY_SELECTION_INSTRUCTION,
  githubFullNameFromInput,
  githubRepositoryLinkagePlan,
} from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';

export type RepoPickerProps = {
  candidates: RepoCandidate[];
  installations?: GitHubInstallationAccess[];
  currentKey?: string | null;
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
  onSelect: (candidate: RepoCandidate) => void;
  onAddAccount?: (owner?: string) => void;
  onManageInstallation?: (installation: GitHubInstallationAccess) => void;
  onCreateRepository?: (installationId: number, name: string) => Promise<void> | void;
  testIDPrefix?: string;
};

/**
 * The candidate list is height-bounded and internally scrollable so an
 * account with 100+ repositories never renders past the fold: every host
 * (room-create panel, corner-open banner, Room-actions sheet) constrains it.
 */
const MAX_LIST_HEIGHT_FRACTION = 0.45;
const MIN_LIST_HEIGHT = 180;
const MAX_LIST_HEIGHT_CAP = 420;

export const RepoPicker = memo(function RepoPicker({
  candidates,
  installations = [],
  currentKey,
  busy = false,
  error,
  notice,
  onSelect,
  onAddAccount,
  onManageInstallation,
  onCreateRepository,
  testIDPrefix = 'repo-picker',
}: RepoPickerProps) {
  const { theme } = useUnistyles();
  const groknight = theme.buzz;
  const { height: windowHeight } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createInstallationId, setCreateInstallationId] = useState<number | null>(null);
  const [pendingLinkage, setPendingLinkage] = useState<
    Exclude<GitHubRepositoryLinkagePlan, { kind: 'available' }> | null
  >(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () => filterRepoCandidates(candidates, query, installations),
    [candidates, query, installations],
  );
  const activeInstallations = installations.filter(
    (installation) => installation.status === 'active',
  );
  const sections = useMemo(
    () => [
      ...installations.map((installation) => ({
        key: `install-${installation.installationId}`,
        installation,
        data: visible.filter(
          (candidate) => candidate.githubInstallationId === installation.installationId,
        ),
      })),
      {
        key: 'ungrouped',
        installation: null,
        data: visible.filter((candidate) => !candidate.githubInstallationId),
      },
    ].filter((section) => normalizedQuery.length > 0 || section.data.length > 0),
    [installations, normalizedQuery, visible],
  );
  // An empty search keeps showing every account header (including 0-repo or
  // suspended installations); a non-empty query drops groups with no hits.
  const listMaxHeight = Math.round(
    Math.min(Math.max(windowHeight * MAX_LIST_HEIGHT_FRACTION, MIN_LIST_HEIGHT), MAX_LIST_HEIGHT_CAP),
  );
  const pastedFullName = githubFullNameFromInput(query);
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

  const candidateRow = (candidate: RepoCandidate) => (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={busy}
      key={candidate.key}
      onPress={() => onSelect(candidate)}
      style={styles.candidateRow}
      testID={`${testIDPrefix}-candidate-${candidate.key}`}
    >
      <Text numberOfLines={1} style={styles.candidateName}>
        {candidate.name}
      </Text>
      {candidate.key === currentKey && <Text style={styles.candidateCheck}>✓</Text>}
    </TouchableOpacity>
  );

  return (
    <View testID={testIDPrefix}>
      <TextInput
        accessibilityLabel="Search repositories or paste a GitHub URL"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        onChangeText={(value) => {
          setQuery(value);
          setPendingLinkage(null);
        }}
        placeholder="Search repos or paste github.com/owner/repo"
        placeholderTextColor={groknight.dim}
        style={styles.search}
        value={query}
      />
      <SectionList
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        renderItem={({ item }) => candidateRow(item)}
        renderSectionHeader={({ section }) =>
          section.installation ? (
            <View style={styles.groupHeader}>
              <Text style={styles.groupName}>{section.installation.accountLogin}</Text>
              <Text style={styles.groupMeta}>
                {section.installation.status === 'active'
                  ? `${section.installation.repositoryCount} REPOS`
                  : section.installation.status.toUpperCase()}
              </Text>
            </View>
          ) : null
        }
        sections={sections}
        style={[styles.candidateScroll, { maxHeight: listMaxHeight }]}
        testID={`${testIDPrefix}-list`}
      />
      {pastedFullName && !exactCandidate && (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            const plan = githubRepositoryLinkagePlan(
              pastedFullName,
              candidates,
              installations,
            );
            if (plan.kind === 'available') onSelect(plan.candidate);
            else setPendingLinkage(plan);
          }}
          style={styles.connectCard}
          testID={`${testIDPrefix}-connect-card`}
        >
          <Text style={styles.connectTitle}>{pastedFullName}</Text>
          <Text style={styles.connectAction}>
            {ownerInstallation?.status === 'active'
              ? 'Add this repo to the Beeline installation →'
              : `Connect ${pastedOwner} →`}
          </Text>
        </TouchableOpacity>
      )}
      {pendingLinkage && (
        <View style={styles.instructionCard} testID={`${testIDPrefix}-link-instruction`}>
          <Text style={styles.instructionTitle}>ON GITHUB</Text>
          <Text style={styles.instructionText}>{GITHUB_REPOSITORY_SELECTION_INSTRUCTION}</Text>
          <View style={styles.instructionActions}>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setPendingLinkage(null)}
              style={styles.instructionButton}
            >
              <Text style={styles.instructionCancel}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => {
                const plan = pendingLinkage;
                setPendingLinkage(null);
                if (plan.kind === 'manage') onManageInstallation?.(plan.installation);
                else onAddAccount?.(plan.owner || undefined);
              }}
              style={styles.instructionButton}
              testID={`${testIDPrefix}-link-continue`}
            >
              <Text style={styles.instructionContinue}>CONTINUE TO GITHUB →</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {!visible.length && !error && !pastedFullName && (
        <Text style={styles.empty}>No repositories match.</Text>
      )}
      {onCreateRepository && activeInstallations.length > 0 && (
        <View>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setCreating((value) => !value);
              setCreateInstallationId(
                (current) => current ?? activeInstallations[0]!.installationId,
              );
            }}
            style={styles.actionRow}
            testID={`${testIDPrefix}-create-repo`}
          >
            <Text style={styles.actionText}>＋ Create a new repo</Text>
          </TouchableOpacity>
          {creating && (
            <View style={styles.createForm}>
              <View style={styles.accountChoices}>
                {activeInstallations.map((installation) => (
                  <TouchableOpacity
                    key={installation.installationId}
                    onPress={() => setCreateInstallationId(installation.installationId)}
                    style={styles.accountChoice}
                  >
                    <Text style={styles.accountChoiceText}>
                      {createInstallationId === installation.installationId ? '●' : '○'}{' '}
                      {installation.accountLogin}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.createRow}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setNewName}
                  placeholder="repository-name"
                  placeholderTextColor={groknight.dim}
                  style={styles.createInput}
                  value={newName}
                />
                <TouchableOpacity
                  disabled={
                    busy || !createInstallationId || !/^[A-Za-z0-9._-]{1,100}$/.test(newName)
                  }
                  onPress={() => {
                    if (!createInstallationId) return;
                    void Promise.resolve(onCreateRepository(createInstallationId, newName))
                      .then(() => {
                        setNewName('');
                        setCreating(false);
                      })
                      .catch(() => undefined);
                  }}
                  style={styles.createButton}
                >
                  <Text style={styles.createButtonText}>CREATE</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}
      {onAddAccount && (
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={() => setPendingLinkage({ kind: 'install', owner: '', fullName: '' })}
          style={styles.actionRow}
          testID={`${testIDPrefix}-add-account`}
        >
          <Text style={styles.actionText}>＋ Add an account or organization</Text>
        </TouchableOpacity>
      )}
      {notice && !error && (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      )}
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          ! {error}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  search: {
    ...Typography.mono(),
    minHeight: 42,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    color: groknight.textPrimary,
    fontSize: 12,
    paddingHorizontal: 0,
  },
  candidateScroll: {
    // Height-bounded so a 100+ repo account scrolls instead of rendering past
    // the fold; the bound scales with the window and is clamped (see the
    // MAX_LIST_HEIGHT_* constants above).
    flexGrow: 0,
  },
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 12,
    paddingBottom: 4,
  },
  groupName: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 13 },
  groupMeta: { ...Typography.mono(), color: groknight.textMuted, fontSize: 9 },
  candidateRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 9,
  },
  candidateName: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 12,
  },
  candidateCheck: { ...Typography.default(), color: groknight.accent, fontSize: 13 },
  empty: { ...Typography.mono(), color: groknight.textMuted, fontSize: 12, paddingVertical: 12 },
  actionRow: {
    minHeight: 44,
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: groknight.border,
  },
  actionText: { ...Typography.mono(), color: groknight.textPrimary, fontSize: 12 },
  connectCard: {
    borderWidth: 1,
    borderColor: groknight.border,
    padding: 12,
    gap: 5,
    marginVertical: 8,
  },
  connectTitle: { ...Typography.mono(), color: groknight.textPrimary, fontSize: 12 },
  connectAction: { ...Typography.default('semiBold'), color: groknight.accent, fontSize: 12 },
  instructionCard: {
    borderWidth: 1,
    borderColor: groknight.accent,
    padding: 12,
    gap: 7,
    marginVertical: 8,
  },
  instructionTitle: { ...Typography.mono(), color: groknight.accent, fontSize: 9 },
  instructionText: { ...Typography.default(), color: groknight.textPrimary, fontSize: 12 },
  instructionActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  instructionButton: { minHeight: 36, justifyContent: 'center' },
  instructionCancel: { ...Typography.mono(), color: groknight.textMuted, fontSize: 10 },
  instructionContinue: { ...Typography.mono(), color: groknight.accent, fontSize: 10 },
  createForm: { gap: 8, paddingBottom: 12 },
  accountChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  accountChoice: { paddingVertical: 4 },
  accountChoiceText: { ...Typography.mono(), color: groknight.textMuted, fontSize: 10 },
  createRow: { flexDirection: 'row', gap: 8 },
  createInput: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    color: groknight.textPrimary,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    fontSize: 12,
  },
  createButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10 },
  createButtonText: { ...Typography.mono(), color: groknight.textPrimary, fontSize: 10 },
  error: {
    ...Typography.mono(),
    color: groknight.danger,
    fontSize: 12,
    paddingTop: 8,
  },
  notice: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
    paddingTop: 8,
  },
  });
});
