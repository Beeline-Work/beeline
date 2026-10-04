import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';
import { Button } from './Button';
import { HULL_SHEET_INSET } from './HullActionSheet';
import { RepoList } from './RepoList';
import {
  RepositoryChoice,
  repositoryChoiceFacts,
  RepositoryReadonlyRow,
  splitFullName,
  type RepoMode,
} from './RepositoryChoice';

type Options = {
  /** The Room actions sheet is open. Each opening starts from the Room's repo. */
  visible: boolean;
  canManage: boolean;
  /** The Room's name: Link preselects a repo with it, Create names the repo after it. */
  roomName: string;
  /** The repo the Room is linked to now, or null. */
  current: RepoCandidate | null;
  candidates: RepoCandidate[];
  installations: GitHubInstallationAccess[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  /** The Link list replaces the sheet body while open. */
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
  onLoad: () => void;
  onConnect: () => void;
  onLink: (repo: RepoCandidate) => void;
  onCreate: (installationId: number, name: string) => Promise<void>;
  onUnlink: () => void;
  onCancel: () => void;
  draftContext: string;
};

/**
 * The Room header sheet's Repository control: the same None / Link / Create
 * choice as New Room, held as a draft until Save.
 */
export function useRoomRepositoryChoice({
  visible,
  canManage,
  roomName,
  current,
  candidates,
  installations,
  loading,
  busy,
  error,
  notice,
  listOpen,
  setListOpen,
  onLoad,
  onConnect,
  onLink,
  onCreate,
  onUnlink,
  onCancel,
  draftContext,
}: Options) {
  const [revealed, setRevealed] = useState(false);
  const [mode, setMode] = useState<RepoMode>('none');
  const [draft, setDraft] = useState<RepoCandidate | null>(null);
  // Link follows the Room name until the user picks a repository themselves.
  const [linkPicked, setLinkPicked] = useState(false);
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const currentKey = current?.key ?? null;
  const name = roomName.replace(/^#/, '').trim();
  const { activeInstallations, selectedInstallation, nameMatch, takenRepo, githubConnected } =
    repositoryChoiceFacts({ name, candidates, installations, installationId });

  // Each opening, and each change the Room's repo goes through, starts over
  // from the Room's own repo.
  useEffect(() => {
    setMode(current ? 'link' : 'none');
    setDraft(current);
    setLinkPicked(Boolean(current));
    setRevealed(false);
    setOwnerMenuOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, visible]);

  // A cold resume from the GitHub install lands back on the Link list.
  useEffect(() => {
    if (!listOpen) return;
    setRevealed(true);
    setMode('link');
  }, [listOpen]);

  useEffect(() => {
    if (mode !== 'link' || linkPicked) return;
    setDraft(nameMatch);
  }, [linkPicked, mode, nameMatch]);

  const reveal = () => {
    setRevealed(true);
    onLoad();
  };

  const chooseMode = (next: RepoMode) => {
    setOwnerMenuOpen(false);
    if (next === mode) return;
    setMode(next);
    setDraft(next === 'link' ? current : null);
    setLinkPicked(next === 'link' && Boolean(current));
  };

  const linkInstead = (repo: RepoCandidate) => {
    setOwnerMenuOpen(false);
    setMode('link');
    setLinkPicked(true);
    setDraft(repo);
  };

  const canSave =
    !busy &&
    (mode === 'none'
      ? current !== null
      : mode === 'link'
        ? draft !== null && draft.key !== currentKey
        : Boolean(selectedInstallation && name && !takenRepo));

  const save = () => {
    if (!canSave) return;
    if (mode === 'none') return onUnlink();
    if (mode === 'link') return draft && onLink(draft);
    // A failed creation keeps its error under the row.
    if (selectedInstallation)
      void onCreate(selectedInstallation.installationId, name).catch(() => undefined);
  };

  const collapsedValue = current ? splitFullName(current).name : 'None';

  const control = !canManage ? (
    <RepositoryReadonlyRow testID="room-repo-readonly" value={collapsedValue} />
  ) : (
    <RepositoryChoice
      activeInstallations={activeInstallations}
      busy={busy}
      collapsedValue={collapsedValue}
      createName={name}
      error={error}
      githubConnected={githubConnected}
      linkRepo={draft}
      loading={loading}
      mode={mode}
      notice={notice}
      onChooseMode={chooseMode}
      onConnect={onConnect}
      onLinkInstead={linkInstead}
      onOpenList={() => setListOpen(true)}
      onReveal={reveal}
      onSelectInstallation={setInstallationId}
      ownerMenuOpen={ownerMenuOpen}
      ownerMenuPlacement="inline"
      revealed={revealed}
      selectedInstallation={selectedInstallation}
      setOwnerMenuOpen={setOwnerMenuOpen}
      takenRepo={takenRepo}
      testIDPrefix="room"
    />
  );

  const list = (
    <View style={styles.inset}>
      <RepoList
        candidates={candidates}
        currentKey={draft?.key ?? null}
        draftContext={draftContext}
        loading={loading}
        onSelect={(candidate) => {
          setLinkPicked(true);
          setDraft(candidate);
          setListOpen(false);
        }}
        testIDPrefix="room-repo-list"
      />
    </View>
  );

  const footer = (
    <View style={styles.actions}>
      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy && !listOpen}
        onPress={() => (listOpen ? setListOpen(false) : onCancel())}
        style={styles.cancelAction}
        testID="room-actions-close"
      >
        <Text style={styles.cancelText}>{listOpen ? 'Back' : 'Cancel'}</Text>
      </TouchableOpacity>
      {canManage && !listOpen && (
        <Button
          disabled={!canSave}
          label={busy ? 'Saving…' : 'Save'}
          loading={busy}
          onPress={save}
          style={styles.primaryAction}
          testID="room-repo-save"
        />
      )}
    </View>
  );

  return {
    listOpen,
    control: <View style={styles.inset}>{control}</View>,
    list,
    footer,
  };
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    inset: { paddingHorizontal: HULL_SHEET_INSET, paddingTop: hull.space.xs },
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
