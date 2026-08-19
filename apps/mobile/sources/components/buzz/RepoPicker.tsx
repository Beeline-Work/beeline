import React, { memo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { groknight } from '@/buzz/groknight';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';
import { MonoButton } from './MonoHull';

export type RepoPickerProps = {
  /** Repos already bound to some Room in this Workspace — see
   * `BuzzRigTransport.workspaceRoomRepositoryCandidates`'s doc for the
   * "no connected-repos source yet" gap this stands in for. */
  candidates: RepoCandidate[];
  currentKey?: string | null;
  busy?: boolean;
  error?: string | null;
  onSelect: (candidate: RepoCandidate) => void;
  onSubmitUrl: (url: string) => void;
  testIDPrefix?: string;
};

/**
 * Shared repo-selection content: a list of repos already bound to some Room
 * in the Workspace, plus a "paste a git URL" fallback. Deliberately no modal
 * chrome of its own — every call site (room creation, corner-open lazy
 * prompt, room settings change) hosts it inside its own surface.
 */
export const RepoPicker = memo(function RepoPicker({
  candidates,
  currentKey,
  busy = false,
  error,
  onSelect,
  onSubmitUrl,
  testIDPrefix = 'repo-picker',
}: RepoPickerProps) {
  const [urlDraft, setUrlDraft] = useState('');
  const [pastingUrl, setPastingUrl] = useState(false);

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
      {pastingUrl ? (
        <View style={styles.urlForm} testID={`${testIDPrefix}-url-form`}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onChangeText={setUrlDraft}
            placeholder="https://github.com/owner/repo"
            placeholderTextColor={groknight.textMuted}
            style={styles.urlInput}
            testID={`${testIDPrefix}-url-input`}
            value={urlDraft}
          />
          <View style={styles.urlFormActions}>
            <MonoButton
              disabled={busy}
              label="CANCEL"
              onPress={() => {
                setPastingUrl(false);
                setUrlDraft('');
              }}
              style={styles.flexButton}
              variant="secondary"
            />
            <MonoButton
              disabled={busy || !urlDraft.trim()}
              label={busy ? 'LINKING…' : 'LINK'}
              loading={busy}
              onPress={() => onSubmitUrl(urlDraft.trim())}
              style={styles.flexButton}
              testID={`${testIDPrefix}-url-submit`}
            />
          </View>
        </View>
      ) : (
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={() => setPastingUrl(true)}
          style={styles.candidateRow}
          testID={`${testIDPrefix}-paste-url`}
        >
          <Text style={styles.pasteUrlLabel}>PASTE A GIT URL</Text>
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
  pasteUrlLabel: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 12,
  },
  urlForm: { paddingVertical: 10, gap: 8 },
  urlInput: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 13,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
    paddingVertical: 8,
  },
  urlFormActions: { flexDirection: 'row', gap: 8 },
  flexButton: { flex: 1, minWidth: 0 },
  error: {
    ...Typography.mono(),
    color: groknight.danger,
    fontSize: 12,
    paddingTop: 8,
  },
}));
