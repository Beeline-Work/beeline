import { appErrorCopy } from '@/buzz/app-error-copy';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';
import { type ChatListHandle } from '@/buzz/chat-list-store';
import { validRoomSlug } from '@/buzz/room-name';
import { inviteOnlyForRepository, type RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { readGitHubAccess, updateGitHubAccess } from '@/buzz/github-access-surface';
import { BuzzRigTransport } from '@/sync/transport';
import { type Identity } from '@beeline/buzz-client';
import { useCallback } from 'react';
import { Keyboard } from 'react-native';

type Props = [
  transport: BuzzRigTransport,
  activeCommunityId: string,
  githubScope: { relay: string; viewer: string; } | null,
  setRepoPickerError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  relayUrl: string,
  identity: Identity,
  setRepoAccessLoading: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setShowRepoPicker: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setPendingRepo: import("react/index").Dispatch<import("react/index").SetStateAction<RepoCandidate | null>>,
  setInviteOnly: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setShowCreateRoom: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setRepoPickerNotice: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setCreatingRepository: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  roomName: string,
  creatingRoom: boolean,
  creatingRepository: boolean,
  canManageWorkspace: boolean,
  setCreatingRoom: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  roomNameDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  inviteOnly: boolean,
  chatStore: import("react/index").RefObject<ChatListHandle | null>,
];
export function useChannelsRepositories([
  transport, activeCommunityId, githubScope, setRepoPickerError, relayUrl, identity,
  setRepoAccessLoading, setShowRepoPicker, setPendingRepo, setInviteOnly, setShowCreateRoom,
  setRepoPickerNotice, setCreatingRepository, roomName, creatingRoom, creatingRepository,
  canManageWorkspace, setCreatingRoom, setError, roomNameDraft, inviteOnly, chatStore,
]: Props): [
  createRoom: (repository: RepoCandidate | null) => Promise<void>,
  handleToggleRepoPicker: () => void,
  handleLoadRepositories: () => Promise<void>,
  handleSelectNoRepository: () => void,
  handleSelectRepoCandidate: (candidate: RepoCandidate) => void,
  handleAddGitHubAccount: () => Promise<void>,
  handleCreateRepository: (installationId: number, name: string) => Promise<RepoCandidate>,
] {


  const loadRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId || !githubScope) return;
      const access = await readGitHubAccess(transport, githubScope, refresh);
      setRepoPickerError(
        access.githubReconnectNeeded
          ? 'GitHub sign-in expired — reconnect GitHub in Settings to see new repositories.'
          : null,
      );
    },
    [activeCommunityId, transport, relayUrl, identity?.publicKey],
  );

  const handleLoadRepositories = useCallback(async () => {
    if (!transport || !activeCommunityId) return;
    setRepoPickerError(null);
    setRepoAccessLoading(true);
    try {
      await loadRepoPicker(true);
    } catch (reason) {
      setRepoPickerError('Could not load repos. Try again.');
    } finally {
      setRepoAccessLoading(false);
    }
  }, [activeCommunityId, loadRepoPicker, transport]);

  const handleToggleRepoPicker = useCallback(() => {
    Keyboard.dismiss();
    setShowRepoPicker((value) => !value);
  }, []);

  const handleSelectRepoCandidate = useCallback((candidate: RepoCandidate) => {
    setPendingRepo(candidate);
    setInviteOnly(inviteOnlyForRepository(candidate));
    setShowRepoPicker(false);
    setRepoPickerError(null);
  }, []);

  const startGitHubInstallation = useCallback(
    async (installationId?: number) => {
      if (!transport) throw new Error('GitHub transport is unavailable');
      return transport.githubInstallationStart(githubInstallationRedirectUri(), installationId);
    },
    [transport],
  );
  const refreshGitHubRepositories = useCallback(() => loadRepoPicker(true), [loadRepoPicker]);
  const resumeRepoPicker = useCallback(async () => {
    setShowCreateRoom(true);
    setShowRepoPicker(true);
  }, []);
  const { handleAddGitHubAccount } = useGitHubInstallationSession({
    ready: Boolean(transport && activeCommunityId),
    returnPath: '/beeline/channels',
    startInstallation: startGitHubInstallation,
    refreshRepositories: refreshGitHubRepositories,
    onError: setRepoPickerError,
    onNotice: setRepoPickerNotice,
    onColdResume: resumeRepoPicker,
  });

  const handleSelectNoRepository = useCallback(() => {
    setPendingRepo(null);
    setInviteOnly(inviteOnlyForRepository(null));
    setShowRepoPicker(false);
    setRepoPickerError(null);
  }, []);

  const handleCreateRepository = useCallback(
    async (installationId: number, name: string) => {
      if (!transport) throw new Error('Connection is still starting. Try again.');
      setRepoPickerError(null);
      setCreatingRepository(true);
      try {
        const repository = await transport.githubRepositoryCreate({
          installationId,
          name,
          private: true,
        });
        if (githubScope)
          await updateGitHubAccess(githubScope, (current) => ({
            ...current,
            candidates: [...current.candidates, repository],
          }));
        setPendingRepo(repository);
        return repository;
      } catch (reason) {
        setRepoPickerError(appErrorCopy(reason, `Could not create repository.`));
        throw reason;
      } finally {
        setCreatingRepository(false);
      }
    },
    [transport],
  );

  const createRoom = useCallback(
    async (repository: RepoCandidate | null) => {
      const name = roomName.trim();
      if (
        !validRoomSlug(name) ||
        !transport ||
        !activeCommunityId ||
        creatingRoom ||
        creatingRepository ||
        !canManageWorkspace
      )
        return;
      setCreatingRoom(true);
      setError(null);
      const clearSubmittedRoom = roomNameDraft.capture();
      let publishAcknowledged = false;
      try {
        await transport.createRoom(name, {
          communityId: activeCommunityId,
          visibility: inviteOnly ? 'invite-only' : 'public',
          repository: repository ?? undefined,
          onPublished: () => {
            publishAcknowledged = true;
            clearSubmittedRoom();
            setInviteOnly(false);
            setPendingRepo(null);
            setShowRepoPicker(false);
            setShowCreateRoom(false);
            chatStore.current?.force();
          },
        });
        if (!publishAcknowledged) {
          clearSubmittedRoom();
          setInviteOnly(false);
          setPendingRepo(null);
          setShowRepoPicker(false);
          setShowCreateRoom(false);
        }
        chatStore.current?.force();
      } catch (reason) {
        setError(
          publishAcknowledged
            ? appErrorCopy(reason, `${ROOM_LABEL} created, but membership is still syncing.`)
            : appErrorCopy(reason, `Could not create ${ROOM_LABEL}.`),
        );
      } finally {
        setCreatingRoom(false);
      }
    },
    [
      activeCommunityId,
      canManageWorkspace,
      creatingRoom,
      creatingRepository,
      inviteOnly,
      roomName,
      roomNameDraft,
      transport,
    ],
  );
return [
    createRoom, handleToggleRepoPicker, handleLoadRepositories, handleSelectNoRepository,
    handleSelectRepoCandidate, handleAddGitHubAccount, handleCreateRepository,
  ];
}
