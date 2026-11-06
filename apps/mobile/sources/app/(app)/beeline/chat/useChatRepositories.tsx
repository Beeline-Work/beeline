import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useCallback } from 'react';
import { Share } from 'react-native';
import { readGitHubAccess, updateGitHubAccess, writeGitHubAccess } from '@/buzz/github-access-surface';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type RoomRepository, type GitHubInstallationAccess } from '@beeline/buzz-client';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { useRoomRepoReplacementGuard } from '@/buzz/room-repo-replacement';
import { GITHUB_REPOSITORY_SELECTION_INSTRUCTION, githubRepositoryLinkagePlan, type RepoCandidate } from '@/buzz/room-repo-picker';
import { ownerGrantShareMessage, type OwnerGrantNeeded } from '@/components/buzz/OwnerGrantNeededCard';
import { type RoomRepositoryOptions } from '@/components/buzz/RoomRepositoryChoice';

type Props = [
  transport: BuzzRigTransport | null,
  activeCommunityId: string | null,
  githubScope: { relay: string; viewer: string; } | null,
  setRoomRepoListLoading: React.Dispatch<React.SetStateAction<boolean>>,
  setRoomRepoError: React.Dispatch<React.SetStateAction<string | null>>,
  chatListRelayUrl: string | null,
  userPubkey: string,
  setShowRoomRepoPicker: React.Dispatch<React.SetStateAction<boolean>>,
  decodedId: string,
  setRoomRepoNotice: React.Dispatch<React.SetStateAction<string | null>>,
  roomRepoBusy: boolean,
  setRoomRepoBusy: React.Dispatch<React.SetStateAction<boolean>>,
  uncoveredOwnersRef: React.RefObject<Set<string>>,
  setOwnerGrant: React.Dispatch<React.SetStateAction<OwnerGrantNeeded | null>>,
  applyRoomRepositoryResult: (result: import("@beeline/api-contract/phone").RoomRepositoryResult) => void,
  setCornerOpenRepoPrompt: React.Dispatch<React.SetStateAction<boolean>>,
  parentChannelId: string | undefined,
  roomRepository: RoomRepository | null,
  clearRoomRepository: () => void,
  canManageWorkspace: boolean,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  roomRepoCandidates: RepoCandidate[],
  githubInstallations: GitHubInstallationAccess[],
  roomRepoListLoading: boolean,
  roomRepoError: string | null,
  roomRepoNotice: string | null,
  showRoomRepoPicker: boolean,
  closeRoomActions: () => void,
  roomRepoAccessIssue: { fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null,
  setRoomRepoAccessIssue: React.Dispatch<React.SetStateAction<{ fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null>>,
];

export function useChatRepositories([
  transport, activeCommunityId, githubScope, setRoomRepoListLoading, setRoomRepoError,
  chatListRelayUrl, userPubkey, setShowRoomRepoPicker, decodedId, setRoomRepoNotice, roomRepoBusy,
  setRoomRepoBusy, uncoveredOwnersRef, setOwnerGrant, applyRoomRepositoryResult,
  setCornerOpenRepoPrompt, parentChannelId, roomRepository, clearRoomRepository, canManageWorkspace,
  roomSurface, roomRepoCandidates, githubInstallations, roomRepoListLoading, roomRepoError,
  roomRepoNotice, showRoomRepoPicker, closeRoomActions, roomRepoAccessIssue, setRoomRepoAccessIssue,
]: Props): [
  handleReconnectRoomRepository: () => Promise<void>,
  handleAddGitHubAccount: () => Promise<void>,
  handleAskOwnerGrant: (fullName: string) => Promise<void>,
  handleCreateGitHubRepository: (installationId: number, name: string) => Promise<void>,
  handleManageGitHubInstallation: (installation: Pick<GitHubInstallationAccess, "installationId">) => Promise<void>,
  handleSelectRoomRepoCandidate: (candidate: RepoCandidate) => void,
  roomRepoOptions: RoomRepositoryOptions,
] {


  const loadRoomRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId || !githubScope) return;
      setRoomRepoListLoading(true);
      try {
        const access = await readGitHubAccess(transport, githubScope, refresh);
        setRoomRepoError(
          access.githubReconnectNeeded
            ? 'GitHub sign-in expired — reconnect GitHub in Settings to see new repositories.'
            : null,
        );
      } catch (error) {
        if (refresh) throw error;
        const candidates = await transport.workspaceRoomRepositoryCandidates();
        await writeGitHubAccess(githubScope, { installed: false, candidates,
          installations: [], githubReconnectNeeded: false });
      } finally {
        setRoomRepoListLoading(false);
      }
    },
    [activeCommunityId, transport, chatListRelayUrl, userPubkey],
  );


  const loadRoomRepoChoice = useCallback(async () => {
    if (!transport || !activeCommunityId) return;
    setRoomRepoError(null);
    try {
      await loadRoomRepoPicker(true);
    } catch (err) {
      setRoomRepoError('Could not load repos. Try again.');
    }
  }, [activeCommunityId, loadRoomRepoPicker, transport]);


  const startGitHubInstallation = useCallback(
    async (installationId?: number) => {
      if (!transport) throw new Error('GitHub transport is unavailable');
      return transport.githubInstallationStart(githubInstallationRedirectUri(), installationId);
    },
    [transport],
  );

  const refreshGitHubRepositories = useCallback(
    () => loadRoomRepoPicker(true),
    [loadRoomRepoPicker],
  );

  const resumeRoomRepoPicker = useCallback(() => {
    setShowRoomRepoPicker(true);
  }, []);

  const { handleAddGitHubAccount, handleManageGitHubInstallation } = useGitHubInstallationSession({
    ready: Boolean(transport && activeCommunityId),
    returnPath: `/beeline/chat/${encodeURIComponent(decodedId)}`,
    startInstallation: startGitHubInstallation,
    refreshRepositories: refreshGitHubRepositories,
    onError: setRoomRepoError,
    onNotice: setRoomRepoNotice,
    onColdResume: resumeRoomRepoPicker,
  });


  const applyRoomRepository = useCallback(
    async (input: RepoCandidate) => {
      if (!transport || !input.remote || roomRepoBusy) return;
      setRoomRepoBusy(true);
      setRoomRepoError(null);
      try {
        // A candidate without a connected installation may be a repository the
        // App never covered (an admin binding a repo whose OWNER has not
        // granted access). Probe the typed coverage state first: binding now
        // would only dead-end the daemon's token path later.
        if (!input.githubInstallationId) {
          const access = await transport.githubRepositoryAccess(input.name).catch(() => undefined);
          if (access && access.accessible === false && access.reason !== 'revoked') {
            uncoveredOwnersRef.current.add(input.name.split('/')[0]?.toLowerCase() ?? '');
            if (access.installUrl) {
              setOwnerGrant({ repository: input.name, installUrl: access.installUrl });
              return;
            }
          }
        }
        const published = await transport.roomRepositorySet(decodedId, {
          key: input.key,
          name: input.name,
          remote: input.remote,
          ...(input.githubInstallationId
            ? { githubInstallationId: input.githubInstallationId }
            : {}),
          ...(input.defaultBranch ? { targetBranch: input.defaultBranch } : {}),
          ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
        });
        applyRoomRepositoryResult(published);
        setShowRoomRepoPicker(false);
        setCornerOpenRepoPrompt(false);
        setOwnerGrant(null);
      } catch (err) {
        setRoomRepoError(appErrorCopy(err, `Could not link repo.`));
      } finally {
        setRoomRepoBusy(false);
      }
    },
    [activeCommunityId, applyRoomRepositoryResult, decodedId, roomRepoBusy, transport],
  );


  // The pasted repository's owner is not among this viewer's installations:
  // resolve the typed coverage state and share the owner's install link
  // instead of opening a connect flow that can never grant a foreign repo.
  const handleAskOwnerGrant = useCallback(
    async (fullName: string) => {
      if (!transport) return;
      setOwnerGrant(null);
      const access = await transport.githubRepositoryAccess(fullName).catch(() => undefined);
      uncoveredOwnersRef.current.add(fullName.split('/')[0]?.toLowerCase() ?? '');
      if (access?.installUrl) {
        setOwnerGrant({ repository: fullName, installUrl: access.installUrl });
        void Share.share({
          message: ownerGrantShareMessage({ repository: fullName, installUrl: access.installUrl }),
        });
        return;
      }
      setRoomRepoNotice(
        access?.accessible
          ? `${fullName} is already available below.`
          : `Could not confirm GitHub coverage for ${fullName}. Try again once the owner has installed the app.`,
      );
    },
    [transport],
  );


  const handleCreateGitHubRepository = useCallback(
    async (installationId: number, name: string) => {
      if (!transport) return;
      setRoomRepoError(null);
      try {
        const candidate = await transport.githubRepositoryCreate({
          installationId,
          name,
          private: true,
        });
        if (githubScope) await updateGitHubAccess(githubScope,
          (current) => ({ ...current, candidates: [...current.candidates, candidate] }));
        await applyRoomRepository(candidate);
      } catch (err) {
        setRoomRepoError(appErrorCopy(err, `Could not create repo.`));
        throw err;
      }
    },
    [applyRoomRepository, transport],
  );


  const {
    openCornerCount,
    selectCandidate: handleSelectRoomRepoCandidate,
    createRepository: handleCreateRoomRepository,
  } = useRoomRepoReplacementGuard(parentChannelId ?? decodedId, roomRepository, {
    link: applyRoomRepository,
    create: handleCreateGitHubRepository,
  });


  // Unassigning the repo is the inverse of linking it: the Room becomes
  // chat-only. It is confirmed like the other destructive Room actions, and
  // the confirm text carries the one room-side consequence that matters —
  // open corners keep their own repo copies, nothing else moves.
  const handleUnlinkRoomRepository = useCallback(async () => {
    if (!transport || !roomRepository || roomRepoBusy) return;
    const hasOpenCorners = openCornerCount > 0;
    const confirmed = await Modal.confirm(
      `Unlink ${roomRepository.binding.name}?`,
      hasOpenCorners
        ? `This ${ROOM_LABEL} becomes chat-only. Open ${CORNER_LABEL}s keep their copies of the repo; messages and history are untouched.`
        : `This ${ROOM_LABEL} becomes chat-only. Messages and history are untouched.`,
      { cancelText: 'Cancel', confirmText: 'Unlink repo', destructive: true },
    );
    if (!confirmed) return;
    setRoomRepoBusy(true);
    setRoomRepoError(null);
    try {
      await transport.roomRepositoryRemove(decodedId);
      clearRoomRepository();
      setShowRoomRepoPicker(false);
    } catch {
      setRoomRepoError('Could not unlink the repository.');
    } finally {
      setRoomRepoBusy(false);
    }
  }, [clearRoomRepository, decodedId, openCornerCount, roomRepoBusy, roomRepository, transport]);


  const roomRepoOptions: RoomRepositoryOptions = {
    canManage: canManageWorkspace,
    roomName: roomSurface?.room.name ?? '',
    current: roomRepository?.binding ?? null,
    candidates: roomRepoCandidates,
    installations: githubInstallations,
    loading: roomRepoListLoading,
    busy: roomRepoBusy,
    error: roomRepoError,
    notice: roomRepoNotice,
    listOpen: showRoomRepoPicker,
    setListOpen: setShowRoomRepoPicker,
    onLoad: () => void loadRoomRepoChoice(),
    onConnect: () => void handleAddGitHubAccount(),
    onLink: handleSelectRoomRepoCandidate,
    onCreate: handleCreateRoomRepository,
    onUnlink: () => void handleUnlinkRoomRepository(),
    onCancel: closeRoomActions,
    draftContext: decodedId,
  };


  const handleReconnectRoomRepository = useCallback(async () => {
    if (!roomRepoAccessIssue || !transport) return;
    setRoomRepoError(null);
    setRoomRepoNotice('Refreshing repositories…');
    let candidates: RepoCandidate[];
    let installations: GitHubInstallationAccess[];
    try {
      if (!githubScope) return;
      const access = await readGitHubAccess(transport, githubScope, true);
      candidates = access.candidates;
      installations = access.installations;
      setRoomRepoNotice(null);
    } catch {
      setRoomRepoNotice(null);
      setRoomRepoError('Could not refresh repositories. Return to Beeline and try again.');
      return;
    }
    const plan = githubRepositoryLinkagePlan(
      roomRepoAccessIssue.fullName,
      candidates,
      installations,
    );
    if (plan.kind === 'available') {
      setRoomRepoAccessIssue(null);
      setCornerOpenRepoPrompt(false);
      return;
    }
    const confirmed = await Modal.confirm(
      'Choose repositories on GitHub',
      GITHUB_REPOSITORY_SELECTION_INSTRUCTION,
      { cancelText: 'Cancel', confirmText: 'Continue to GitHub' },
    );
    if (!confirmed) return;
    if (plan.kind === 'manage') void handleManageGitHubInstallation(plan.installation);
    else void handleAddGitHubAccount();
  }, [handleAddGitHubAccount, handleManageGitHubInstallation, roomRepoAccessIssue, transport]);
  return [
    handleReconnectRoomRepository, handleAddGitHubAccount, handleAskOwnerGrant,
    handleCreateGitHubRepository, handleManageGitHubInstallation, handleSelectRoomRepoCandidate,
    roomRepoOptions,
  ];
}
