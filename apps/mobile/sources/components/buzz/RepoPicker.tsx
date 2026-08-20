import React, { memo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { groknight } from '@/buzz/groknight';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';

export type RepoPickerProps = {
  /** Repositories granted to the account's Beeline GitHub App installation. */
  candidates: RepoCandidate[];
  currentKey?: string | null;
  busy?: boolean;
  error?: string | null;
  onSelect: (candidate: RepoCandidate) => void;
  testIDPrefix?: string;
};

/**
 * Shared repo-selection content from the GitHub App installation. Deliberately no modal
 * chrome of its own — every call site (room creation, corner-open lazy
 * prompt, room settings change) hosts it inside its own surface.
 */
export const RepoPicker = memo(function RepoPicker({
  candidates,
  currentKey,
  busy = false,
  error,
  onSelect,
  testIDPrefix = 'repo-picker',
}: RepoPickerProps) {
  return (
    <View testID={testIDPrefix}>
      {candidates.map((candidate) => (
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
      ))}
      {!candidates.length && !error && (
        <Text style={styles.empty}>
          No repositories are available to this GitHub App installation.
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

const styles = StyleSheet.create(() => ({
  candidateRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 10,
  },
  candidateName: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 13,
  },
  candidateCheck: { ...Typography.default(), color: groknight.accent, fontSize: 13 },
  empty: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 12,
  },
  error: {
    ...Typography.mono(),
    color: groknight.danger,
    fontSize: 12,
    paddingTop: 8,
  },
}));
