import React, { memo, useMemo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { githubFullNameFromInput } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';

export type RepoPickerProps = {
  candidates: RepoCandidate[];
  installations?: GitHubInstallationAccess[];
  currentKey?: string | null;
  busy?: boolean;
  error?: string | null;
  onSelect: (candidate: RepoCandidate) => void;
  onAddAccount?: (owner?: string) => void;
  onManageInstallation?: (url: string) => void;
  onCreateRepository?: (installationId: number, name: string) => Promise<void> | void;
  testIDPrefix?: string;
};

export const RepoPicker = memo(function RepoPicker({
  candidates,
  installations = [],
  currentKey,
  busy = false,
  error,
  onSelect,
  onAddAccount,
  onManageInstallation,
  onCreateRepository,
  testIDPrefix = 'repo-picker',
}: RepoPickerProps) {
  const { theme } = useUnistyles();
  const groknight = theme.buzz;
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createInstallationId, setCreateInstallationId] = useState<number | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      candidates.filter(
        (candidate) => !normalizedQuery || candidate.name.toLowerCase().includes(normalizedQuery),
      ),
    [candidates, normalizedQuery],
  );
  const activeInstallations = installations.filter(
    (installation) => installation.status === 'active',
  );
  const groups = installations.map((installation) => ({
    installation,
    candidates: visible.filter(
      (candidate) => candidate.githubInstallationId === installation.installationId,
    ),
  }));
  const ungrouped = visible.filter((candidate) => !candidate.githubInstallationId);
  const pastedFullName = githubFullNameFromInput(query);
  const exactCandidate = pastedFullName
    ? candidates.find((candidate) => candidate.name.toLowerCase() === pastedFullName.toLowerCase())
    : undefined;
  const pastedOwner = pastedFullName?.split('/')[0];
  const ownerInstallation = pastedOwner
    ? installations.find(
        (installation) => installation.accountLogin.toLowerCase() === pastedOwner.toLowerCase(),
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
        onChangeText={setQuery}
        placeholder="Search repos or paste github.com/owner/repo"
        placeholderTextColor={groknight.dim}
        style={styles.search}
        value={query}
      />
      {groups.map(({ installation, candidates: accountCandidates }) => {
        if (!accountCandidates.length && normalizedQuery) return null;
        return (
          <View key={installation.installationId} style={styles.group}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupName}>{installation.accountLogin}</Text>
              <Text style={styles.groupMeta}>
                {installation.status === 'active'
                  ? `${installation.repositoryCount} REPOS`
                  : installation.status.toUpperCase()}
              </Text>
            </View>
            {accountCandidates.map(candidateRow)}
          </View>
        );
      })}
      {ungrouped.map(candidateRow)}
      {pastedFullName && !exactCandidate && (
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            if (ownerInstallation?.status === 'active') {
              onManageInstallation?.(ownerInstallation.manageUrl);
            } else {
              onAddAccount?.(pastedOwner);
            }
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
          onPress={() => onAddAccount()}
          style={styles.actionRow}
          testID={`${testIDPrefix}-add-account`}
        >
          <Text style={styles.actionText}>＋ Add an account or organization</Text>
        </TouchableOpacity>
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
  group: { paddingTop: 12 },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingBottom: 4 },
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
  });
});
