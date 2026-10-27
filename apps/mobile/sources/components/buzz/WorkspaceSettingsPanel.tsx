import { appErrorCopy } from '@/buzz/app-error-copy';
import { connectionErrorDescription } from '@/buzz/app-error-copy';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useFocusEffect, type Href } from 'expo-router';
import {
  SurfaceRefreshScheduler,
  isWorkspaceView,
  type BuzzClient,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { roomTitle } from '@beeline/api-contract/phone';
import { RoomViewClient } from '@/sync/transport/room-view-client';

import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { refreshChatList, useChatList, type ChatListKey } from '@/buzz/chat-list-store';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { buildCommunityInviteUrl } from '@/buzz/community-invite';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { isWorkspaceOwnerRole } from '@/buzz/workspace-role';
import { MEMBERS_LABEL, ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { roomHref } from '@/buzz/corner-navigation';
import { HullDialog } from '@/components/buzz/HullDialog';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';

type WorkspaceRoomSetting = {
  id: string;
  name: string;
  visibility: 'public' | 'invite-only';
  canManage: boolean;
  /** Undefined until the viewer's Room list has loaded. */
  joined?: boolean;
  createdAt?: number;
};

export function WorkspaceDeleteConfirmDialog({
  visible,
  workspaceName,
  value,
  busy,
  onChangeText,
  onClose,
  onDelete,
}: {
  visible: boolean;
  workspaceName: string;
  value: string;
  busy: boolean;
  onChangeText: (value: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <HullDialog
      accessibilityLabel={`Close delete ${WORKSPACE_LABEL} confirmation`}
      onRequestClose={onClose}
      dismissOnBackdrop={!busy}
      body={`This permanently deletes every ${ROOM_LABEL}, message, and member of "${workspaceName}". This cannot be undone. Type its name to confirm.`}
      testID="workspace-delete-sheet"
      title={`Delete ${WORKSPACE_LABEL}?`}
      visible={visible}
      actions={[
        { label: 'Cancel', onPress: onClose, disabled: busy, testID: 'workspace-delete-cancel' },
        {
          label: busy ? 'Deleting…' : `Delete ${WORKSPACE_LABEL}`,
          onPress: onDelete,
          variant: 'destructive',
          busy,
          disabled: busy || !workspaceName || value.trim() !== workspaceName,
          testID: 'workspace-delete-confirm',
        },
      ]}
    >
      <View style={styles.inlineEditor}>
        <HullDialogInput
          accessibilityLabel={`Type ${workspaceName} to confirm`}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onChangeText={onChangeText}
          placeholder={workspaceName}
          placeholderTextColor={theme.buzz.dim}
          style={styles.input}
          testID="workspace-delete-confirm-input"
          value={value}
        />
      </View>
    </HullDialog>
  );
}

const ROOM_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export const WORKSPACE_VISIBILITY_LABELS = { public: 'Public', 'invite-only': 'Invite-only' } as const;
const ROOM_VISIBILITY_LABELS = { public: 'Public', 'invite-only': 'Invite-only' } as const;

function roomCreatedQualifier(createdAt: number | undefined): string | undefined {
  if (createdAt === undefined) return undefined;
  const created = new Date(createdAt * 1_000);
  return `Created ${ROOM_DATE_FORMATTER.format(created)} · ${created.toISOString().slice(11, 19)} UTC`;
}

/** What the Settings header asks of this tab: its picture is the control that changes it. */
export type WorkspaceSettingsHandle = { changePicture: () => void };

/**
 * The workspace tab of Settings: one list of `SettingsRow`s under General,
 * People and Rooms. Owners and admins edit; members see the same rows
 * read-only, copy the public join link and open the member list.
 */
const WorkspaceSettings = React.forwardRef<WorkspaceSettingsHandle, { workspaceId?: string }>(
function WorkspaceSettings({ workspaceId }, ref) {
  const { theme } = useUnistyles();
  const communityId = workspaceId;
  const [joinLinkBusy, setJoinLinkBusy] = useState(false);
  const joinLinkGeneration = useRef(0);
  const [publicJoinUrl, setPublicJoinUrl] = useState<string | null>(null);
  const [joinLinkCopied, setJoinLinkCopied] = useState(false);
  const [client, setClient] = useState<BuzzClient | null>(null);
  const [workspaceAddress, setWorkspaceAddress] = useState<ReturnType<typeof surfaceAddress> | null>(null);
  const workspaceView = useSurfaceSnapshot(workspaceAddress, isWorkspaceView);
  const paintedWorkspaceId = useRef<string | null>(null);
  const [chatListKey, setChatListKey] = useState<ChatListKey | null>(null);
  const [workspaceName, setWorkspaceName, workspaceDraft] = useTextDraft(`workspace-name:${communityId}`,
    '',
  );
  const [renamingWorkspace, setRenamingWorkspace] = useState(false);
  const [visibilityPickerOpen, setVisibilityPickerOpen] = useState(false);
  const [roomSheetId, setRoomSheetId] = useState<string | null>(null);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText, deletionDraft] = useTextDraft(`workspace-delete:${communityId}`,
    '',
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorRow, setErrorRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const workspaceSchedulerRef = useRef<SurfaceRefreshScheduler<WorkspaceView | null> | null>(null);
  // The Room names come from the app-level Room list, which owns its watch and reads.
  const chatList = useChatList(chatListKey, { onError: (reason) => setError(appErrorCopy(reason)) });

  const workspace = workspaceView?.workspace;
  useEffect(() => {
    if (workspace) workspaceDraft.initialize(workspace.name);
  }, [workspace?.name, workspaceDraft]);
  const canManageWorkspace = workspaceView?.viewer.permissions.manage === true;
  const loadPublicJoinLink = useCallback(async () => {
    if (!communityId || workspace?.visibility !== 'public') return;
    const generation = ++joinLinkGeneration.current;
    setErrorRow('join-link');
    setJoinLinkBusy(true);
    setError(null);
    try {
      const invite = await monolithPhoneOperation('createInvite', {
        workspaceId: communityId,
      });
      if (generation !== joinLinkGeneration.current) return;
      setPublicJoinUrl(buildCommunityInviteUrl(invite.token, getBuzzRuntimeConfig().relayUrl));
      setJoinLinkCopied(false);
    } catch (caught) {
      if (generation === joinLinkGeneration.current)
        setError(appErrorCopy(caught, `Could not load public join link.`));
    } finally {
      if (generation === joinLinkGeneration.current) setJoinLinkBusy(false);
    }
  }, [communityId, workspace?.visibility]);
  useEffect(() => {
    setPublicJoinUrl(null);
    setJoinLinkBusy(false);
    void loadPublicJoinLink();
    return () => {
      joinLinkGeneration.current += 1;
    };
  }, [loadPublicJoinLink]);
  const isWorkspaceOwner = isWorkspaceOwnerRole(workspaceView?.viewer.role);
  const rooms = useMemo<WorkspaceRoomSetting[]>(() => {
    const indexedRooms = workspaceView?.managerSettings?.rooms;
    const joinedRooms = new Map(
      (chatList?.chats ?? [])
        .filter((item) => !item.room.archived && !item.directMessage)
        .map((item) => [item.room.id, item.room]),
    );
    const visibleRooms =
      indexedRooms ??
      [...joinedRooms.values()].map((room) => ({
        id: room.id,
        name: room.name,
        visibility: room.visibility ?? 'public',
        createdAt: room.createdAt,
      }));
    return visibleRooms
      .map((room) => {
        return {
          ...room,
          canManage: canManageWorkspace,
          // Membership comes from the viewer's own Room list, never the manager index.
          joined: chatList ? joinedRooms.has(room.id) : undefined,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [canManageWorkspace, chatList, workspaceView?.managerSettings?.rooms]);
  const duplicateRoomNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const room of rooms) {
      const key = room.name.trim().toLocaleLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [rooms]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let workspaceScheduler: SurfaceRefreshScheduler<WorkspaceView | null> | undefined;
      if (paintedWorkspaceId.current !== communityId) {
        setLoading(true);
        setWorkspaceAddress(null);
        setChatListKey(null);
        paintedWorkspaceId.current = communityId ?? null;
      }
      setError(null);
      void (async () => {
        if (!communityId) {
          setError('Workspace target is missing.');
          setLoading(false);
          return;
        }
        try {
          const [currentIdentity, currentRelayUrl] = await Promise.all([
            loadBuzzIdentity(), getEffectiveRelayUrl(),
          ]);
          if (cancelled) return;
          if (!currentIdentity) {
            router.replace('/beeline/onboarding');
            return;
          }
          const address = surfaceAddress(currentRelayUrl, currentIdentity.publicKey, '/workspace/:id', { workspaceId: communityId });
          setWorkspaceAddress(address);
          setChatListKey({
            relayUrl: currentRelayUrl, viewerPubkey: currentIdentity.publicKey, workspaceId: communityId,
          });
          const cachedWorkspace = await mobileSurfaceCache.read(address, isWorkspaceView);
          if (cancelled) return;
          if (cachedWorkspace) {
            setLoading(false);
          }
          const transport = new BuzzRigTransport(currentIdentity);
          const currentClient = await transport.ensureClient();
          if (cancelled) return;
          setClient(currentClient);
          const http = new RoomViewClient({ baseUrl: currentRelayUrl, identity: currentIdentity });
          workspaceScheduler = new SurfaceRefreshScheduler({
            fetch: () => mobileSurfaceCache.fetch(address, isWorkspaceView, () => http.workspace(communityId)),
            apply: (value) => {
              // Null: an eviction overtook the read; there is nothing to paint.
              if (!value) return;
              setLoading(false);
              setError(null);
            },
            onError: (reason) => {
              setLoading(false);
              setError(appErrorCopy(reason));
            },
          });
          workspaceSchedulerRef.current = workspaceScheduler;
          await workspaceScheduler.startAfter(Promise.resolve());
        } catch (caught) {
          if (!cancelled) setError(appErrorCopy(caught, `Could not load ${WORKSPACE_LABEL} settings.`));
        } finally {
          if (!cancelled && !workspaceScheduler) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
        workspaceScheduler?.dispose();
        workspaceSchedulerRef.current = null;
      };
    }, [communityId, retryGeneration]),
  );

  const saveWorkspaceName = useCallback(async () => {
    if (!client || !communityId || !workspaceName.trim()) return;
    setErrorRow('name');
    setWorkingKey('name');
    setError(null);
    const clearWorkspace = workspaceDraft.capture(false);
    try {
      await client.renameCommunity(communityId, workspaceName);
      clearWorkspace();
      workspaceSchedulerRef.current?.force();
      setRenamingWorkspace(false);
    } catch (caught) {
      setError(appErrorCopy(caught, `Could not rename ${WORKSPACE_LABEL}.`));
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId, workspaceName, workspaceDraft]);

  const changeWorkspacePicture = useCallback(async () => {
    if (!client || !communityId || !canManageWorkspace) return;
    setErrorRow('picture');
    setWorkingKey('picture');
    setError(null);
    try {
      const avatar = await pickAndUploadAvatar(client);
      if (!avatar) return;
      await client.setCommunityAvatar(communityId, avatar);
      workspaceSchedulerRef.current?.force();
    } catch (caught) {
      setError(appErrorCopy(caught, `Could not set ${WORKSPACE_LABEL} picture.`));
    } finally {
      setWorkingKey(null);
    }
  }, [canManageWorkspace, client, communityId]);

  useImperativeHandle(ref, () => ({ changePicture: () => void changeWorkspacePicture() }), [changeWorkspacePicture]);

  const resetWorkspacePicture = useCallback(async () => {
    if (!client || !communityId || !canManageWorkspace) return;
    setErrorRow('picture');
    setWorkingKey('picture');
    setError(null);
    try {
      await client.setCommunityAvatar(communityId, '');
      workspaceSchedulerRef.current?.force();
    } catch (caught) {
      setError(appErrorCopy(caught, `Could not reset ${WORKSPACE_LABEL} picture.`));
    } finally {
      setWorkingKey(null);
    }
  }, [canManageWorkspace, client, communityId]);

  const changeWorkspaceVisibility = useCallback(
    async (visibility: 'public' | 'invite-only') => {
      setVisibilityPickerOpen(false);
      if (!client || !communityId || workspace?.visibility === visibility) return;
      setErrorRow('visibility');
      setWorkingKey('visibility');
      setError(null);
      try {
        await client.setCommunityVisibility(communityId, visibility);
        workspaceSchedulerRef.current?.force();
      } catch (caught) {
        setError(appErrorCopy(caught, `Could not change ${WORKSPACE_LABEL} visibility.`));
      } finally {
        setWorkingKey(null);
      }
    },
    [client, communityId, workspace?.visibility],
  );

  const changeRoomVisibility = useCallback(
    async (room: WorkspaceRoomSetting) => {
      if (!client || !room.canManage) return;
      const visibility = room.visibility === 'public' ? 'invite-only' : 'public';
      setRoomSheetId(null);
      setErrorRow(`room-${room.id}`);
      setWorkingKey(`room-${room.id}`);
      setError(null);
      try {
        await monolithPhoneOperation('updateRoom', { roomId: room.id, visibility });
        workspaceSchedulerRef.current?.force();
        if (chatListKey) refreshChatList(chatListKey);
      } catch (caught) {
        setError(appErrorCopy(caught, `Could not change ${ROOM_LABEL} visibility.`));
      } finally {
        setWorkingKey(null);
      }
    },
    [chatListKey, client],
  );

  const joinRoom = useCallback(
    async (room: WorkspaceRoomSetting) => {
      const viewerId = chatListKey?.viewerPubkey;
      if (!viewerId || !room.canManage) return;
      setErrorRow(`room-${room.id}`);
      setWorkingKey(`room-${room.id}`);
      setError(null);
      try {
        await monolithPhoneOperation('addRoomMember', { roomId: room.id, memberId: viewerId });
        setRoomSheetId(null);
        if (chatListKey) refreshChatList(chatListKey);
        router.push(roomHref(room.id, communityId));
      } catch (caught) {
        setRoomSheetId(null);
        setError(appErrorCopy(caught, `Could not join ${roomTitle(room.name) ?? room.name}.`));
      } finally {
        setWorkingKey(null);
      }
    },
    [chatListKey, communityId],
  );

  const closeDeleteSheet = useCallback(() => {
    if (deleteBusy) return;
    setDeleteSheetOpen(false);
  }, [deleteBusy]);

  const confirmDeleteWorkspace = useCallback(async () => {
    if (!communityId || !workspace || deleteConfirmText.trim() !== workspace.name || deleteBusy)
      return;
    const clearDeletion = deletionDraft.capture();
    setErrorRow('delete');
    setDeleteBusy(true);
    setError(null);
    try {
      // Above the server's own transaction deadline (APP_TRANSACTION_DEADLINE_MS,
      // 30s), so this never races a legitimate slow delete to a false timeout;
      // it only catches the request truly never answering, which otherwise left
      // this dialog stuck on "Deleting..." forever.
      await monolithPhoneOperation(
        'deleteWorkspace',
        { workspaceId: communityId },
        { timeoutMs: 40_000 },
      );
      clearDeletion();
      setDeleteSheetOpen(false);
      router.replace('/beeline/channels');
    } catch (caught) {
      setError(appErrorCopy(caught, `Could not delete ${WORKSPACE_LABEL}.`));
      setDeleteBusy(false);
    }
  }, [communityId, deleteBusy, deleteConfirmText, workspace, deletionDraft]);

  if (loading) {
    return (
      <View style={styles.center}>
        <SurfaceGlyphLoader testID="workspace-settings-loader" />
      </View>
    );
  }

  const sheetRoom = rooms.find((room) => room.id === roomSheetId);
  const sheetRoomWorking = sheetRoom !== undefined && workingKey === `room-${sheetRoom.id}`;
  const peopleTotal = workspaceView?.peopleTotal;
  const agentTotal = workspaceView?.agentTotal;
  const memberCount =
    peopleTotal === undefined || agentTotal === undefined ? undefined : peopleTotal + agentTotal;
  const visibilityLabel = workspace?.visibility ? WORKSPACE_VISIBILITY_LABELS[workspace.visibility] : undefined;
  const copyJoinLink = () => {
    if (!publicJoinUrl) {
      void loadPublicJoinLink();
      return;
    }
    void Clipboard.setStringAsync(publicJoinUrl).then(() => setJoinLinkCopied(true));
  };

  return (
    <View style={styles.container}>
      {!workspaceView ? (
        <SettingsRow title={error ?? `Could not load ${WORKSPACE_LABEL} settings`} description={connectionErrorDescription} action="Retry" onPress={() => setRetryGeneration((value) => value + 1)} testID="workspace-settings-retry" />
      ) : (
        <View testID={canManageWorkspace ? 'workspace-settings-manage' : 'workspace-settings-read-only'}>
          {error && !errorRow ? <SettingsRow title={error} description={connectionErrorDescription} action="Retry" onPress={() => setRetryGeneration((value) => value + 1)} /> : null}
          <View testID="workspace-overview-settings">
            <RoomListSectionHeader title="General" inset="content" />
            {canManageWorkspace ? (
              <SettingsRow
                accessibilityLabel={`${WORKSPACE_LABEL} name`}
                chevron={renamingWorkspace ? 'down' : 'right'}
                onPress={() => {
                  workspaceDraft.initialize(workspace?.name ?? '');
                  setRenamingWorkspace((open) => !open);
                }}
                testID="workspace-name-row"
                title="Name"
                value={renamingWorkspace ? undefined : (workspace?.name ?? '')}
                description={error && errorRow === 'name' ? error : undefined}
                descriptionTone={error && errorRow === 'name' ? 'danger' : undefined}
              />
            ) : (
              <SettingsRow testID="workspace-name-row" title="Name" value={workspace?.name ?? ''} />
            )}
            {renamingWorkspace && canManageWorkspace && (
              <View style={styles.inlineEditor} testID="workspace-name-editor">
                <HullDialogInput
                  accessibilityLabel={`New ${WORKSPACE_LABEL} name`}
                  autoFocus
                  editable={workingKey !== 'name'}
                  maxLength={80}
                  onChangeText={setWorkspaceName}
                  onSubmitEditing={() => void saveWorkspaceName()}
                  placeholder={`${WORKSPACE_LABEL} name`}
                  placeholderTextColor={theme.buzz.dim}
                  returnKeyType="done"
                  selectTextOnFocus
                  style={styles.input}
                  testID="workspace-name-input"
                  value={workspaceName}
                />
                <HullDialogActions style={styles.inlineEditorControls} actions={[{ disabled: workingKey === 'name', label: "Cancel", onPress: () => setRenamingWorkspace(false), variant: "quiet" }, { disabled: !workspaceName.trim() ||
                      workspaceName.trim() === workspace?.name ||
                      workingKey === 'name', label: workingKey === 'name' ? 'Saving…' : 'Save', loading: workingKey === 'name', onPress: () => void saveWorkspaceName(), testID: "workspace-name-save", variant: 'primary' }]} />
              </View>
            )}

            <View testID="workspace-visibility-setting">
              {canManageWorkspace ? (
                <SettingsRow
                  accessibilityLabel={`Change who can find this ${WORKSPACE_LABEL}`}
                  chevron="right"
                  disabled={workingKey === 'visibility'}
                  onPress={() => setVisibilityPickerOpen(true)}
                  testID="workspace-visibility-row"
                  title="Visibility"
                  value={visibilityLabel}
                description={error && errorRow === 'visibility' ? error : undefined}
                descriptionTone={error && errorRow === 'visibility' ? 'danger' : undefined}
              />
              ) : (
                <SettingsRow testID="workspace-visibility-row" title="Visibility" value={visibilityLabel} />
              )}
            </View>

            {workspace?.visibility === 'public' && (
              <View testID="workspace-public-join-setting">
                <SettingsRow
                  accessibilityLabel="Copy public join link"
                  action={joinLinkBusy ? 'Loading…' : joinLinkCopied ? 'Copied' : 'Copy'}
                  description={error && errorRow === 'join-link' ? error : 'Anyone with the link can join'}
                  disabled={workingKey !== null || joinLinkBusy}
                  onPress={copyJoinLink}
                  testID="workspace-public-join-copy"
                  title="Public join link"
                  descriptionTone={error && errorRow === 'join-link' ? 'danger' : undefined}
              />

              </View>
            )}
            {canManageWorkspace && (workspace?.avatar || (error && errorRow === 'picture')) ? (
              <SettingsRow
                disabled={workingKey === 'picture'}
                onPress={() => void resetWorkspacePicture()}
                testID="workspace-picture-clear"
                title="Use generated mark"
                tone="action"
                description={error && errorRow === 'picture' ? error : undefined}
                descriptionTone={error && errorRow === 'picture' ? 'danger' : undefined}
              />
            ) : null}

            {canManageWorkspace ? (
              <SettingsRow
                title="Allow fix sweep"
                description={error && errorRow === 'fix-sweep' ? error : 'Helps Beeline improve'}
                testID="workspace-fix-sweep"
                toggle={{
                  value: workspaceView?.managerSettings?.allowFixSweep === true,
                  disabled: workingKey !== null || typeof workspaceView?.managerSettings?.allowFixSweep !== 'boolean',
                  onValueChange: (allowFixSweep) => {
                    if (!communityId) return;
                    setErrorRow('fix-sweep');
                    setWorkingKey('fix-sweep');
                    setError(null);
                    void monolithPhoneOperation('updateWorkspace', { workspaceId: communityId, allowFixSweep })
                      .then(() => workspaceSchedulerRef.current?.force())
                      .catch((caught) => setError(appErrorCopy(caught, `Could not update Allow fix sweep.`)))
                      .finally(() => setWorkingKey(null));
                  },
                }}
                descriptionTone={error && errorRow === 'fix-sweep' ? 'danger' : undefined}
              />
            ) : null}

          </View>

          <View testID="workspace-members-link">
            <RoomListSectionHeader title="People" inset="content" />
            <SettingsRow
              chevron="right"
              description={canManageWorkspace ? 'Invite people and agents, set roles' : undefined}
              onPress={() =>
                router.push({
                  pathname: '/beeline/members',
                  params: { communityId },
                } as unknown as Href)
              }
              testID="open-members"
              title={MEMBERS_LABEL}
              value={memberCount === undefined ? undefined : String(memberCount)}
            />
          </View>

          {canManageWorkspace && (
            <View testID="channel-visibility-settings">
              <RoomListSectionHeader title={`${ROOM_LABEL}s`} inset="content" />
              {workspaceView?.managerSettings?.roomsTruncated && (
                <Text style={styles.sectionNote} testID="room-visibility-truncated">
                  Showing the first 200 {ROOM_LABEL}s.
                </Text>
              )}
              {rooms.map((room) => {
                const displayName = roomTitle(room.name) ?? room.name;
                const duplicateName = duplicateRoomNames.has(room.name.trim().toLocaleLowerCase());
                const description = [
                  room.joined === false ? 'Not joined' : undefined,
                  duplicateName ? roomCreatedQualifier(room.createdAt) : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <View key={room.id}>
                    <SettingsRow
                      accessibilityLabel={`Show actions for ${ROOM_LABEL} ${displayName}`}
                      chevron="right"
                      description={error && errorRow === `room-${room.id}` ? error : description || undefined}
                      descriptionTone={error && errorRow === `room-${room.id}` ? 'danger' : undefined}
                      descriptionAction={
                        duplicateName
                          ? {
                              accessibilityLabel: `View details for ${ROOM_LABEL} ${displayName}`,
                              label: 'Details',
                              onPress: () => setRoomSheetId(room.id),
                              testID: `room-details-${room.id}`,
                            }
                          : undefined
                      }
                      disabled={!room.canManage || workingKey === `room-${room.id}`}
                      onPress={() => setRoomSheetId(room.id)}
                      testID={`room-visibility-${room.id}`}
                      title={displayName}
                      value={ROOM_VISIBILITY_LABELS[room.visibility]}
                    />

                  </View>
                );
              })}
            </View>
          )}

          {isWorkspaceOwner && (
            <View style={styles.dangerSection}>
              <SettingsRow
                accessibilityLabel={`Delete this ${WORKSPACE_LABEL}`}
                onPress={() => setDeleteSheetOpen(true)}
                testID="workspace-delete-row"
                title={`Delete ${WORKSPACE_LABEL}`}
                tone="destructive"
                description={error && errorRow === 'delete' ? error : undefined}
                descriptionTone={error && errorRow === 'delete' ? 'danger' : undefined}
              />

            </View>
          )}


        </View>
      )}

      <HullActionSheetModal
        accessibilityLabel="Close visibility picker"
        onClose={() => setVisibilityPickerOpen(false)}
        subtitle="Invite-only keeps discovery closed. Existing members keep their access."
        testID="workspace-visibility-sheet"
        title={`Who can find this ${WORKSPACE_LABEL}?`}
        visible={visibilityPickerOpen}
      >
        {(['public', 'invite-only'] as const).map((visibility) => (
          <HullActionSheetRow
            disabled={workingKey === 'visibility'}
            key={visibility}
            label={WORKSPACE_VISIBILITY_LABELS[visibility]}
            onPress={() => void changeWorkspaceVisibility(visibility)}
            selected={workspace?.visibility === visibility}
            testID={`workspace-visibility-${visibility}`}
          />
        ))}
        <HullActionSheetCancel
          onPress={() => setVisibilityPickerOpen(false)}
          testID="workspace-visibility-close"
        />
      </HullActionSheetModal>


      <HullActionSheetModal
        accessibilityLabel={`Close ${ROOM_LABEL} actions`}
        onClose={() => setRoomSheetId(null)}
        subtitle={
          sheetRoom
            ? `${ROOM_VISIBILITY_LABELS[sheetRoom.visibility]}${
                sheetRoom.joined === undefined
                  ? ''
                  : sheetRoom.joined
                    ? ' · you are a member'
                    : ' · you are not a member'
              }`
            : undefined
        }
        testID="room-sheet"
        title={sheetRoom ? (roomTitle(sheetRoom.name) ?? sheetRoom.name) : undefined}
        visible={sheetRoom !== undefined}
      >
        {sheetRoom ? (
          <>
            {sheetRoom.joined === false && (
              <HullActionSheetRow
                description="Adds you as a member and opens it."
                disabled={sheetRoomWorking}
                label={sheetRoomWorking ? 'Joining…' : `Join ${ROOM_LABEL.toLowerCase()}`}
                onPress={() => void joinRoom(sheetRoom)}
                testID="room-sheet-join"
              />
            )}
            {sheetRoom.joined === true && (
              <HullActionSheetRow
                chevron="right"
                disabled={sheetRoomWorking}
                label={`Open ${ROOM_LABEL.toLowerCase()}`}
                onPress={() => {
                  setRoomSheetId(null);
                  router.push(roomHref(sheetRoom.id, communityId));
                }}
                testID="room-sheet-open"
              />
            )}
            <HullActionSheetRow
              description={
                sheetRoom.visibility === 'public'
                  ? 'Existing members keep their access.'
                  : `Anyone in the ${WORKSPACE_LABEL} can find and join.`
              }
              disabled={sheetRoomWorking}
              label={`Make ${
                ROOM_VISIBILITY_LABELS[sheetRoom.visibility === 'public' ? 'invite-only' : 'public']
              }`}
              onPress={() => void changeRoomVisibility(sheetRoom)}
              testID="room-sheet-visibility"
            />
            <HullActionSheetRow
              label={`Copy ${ROOM_LABEL} ID`}
              metadata={sheetRoom.id}
              onPress={() => {
                setRoomSheetId(null);
                void Clipboard.setStringAsync(sheetRoom.id);
              }}
              testID="room-sheet-copy-id"
            />
          </>
        ) : null}
        <HullActionSheetCancel onPress={() => setRoomSheetId(null)} testID="room-sheet-close" />
      </HullActionSheetModal>

      <WorkspaceDeleteConfirmDialog
        visible={deleteSheetOpen}
        workspaceName={workspace?.name ?? ''}
        value={deleteConfirmText}
        busy={deleteBusy}
        onChangeText={setDeleteConfirmText}
        onClose={closeDeleteSheet}
        onDelete={() => void confirmDeleteWorkspace()}
      />
    </View>
  );
});

export default WorkspaceSettings;

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { backgroundColor: hull.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center', paddingVertical: hull.space.xxl },
    dangerSection: { paddingTop: hull.layout.sectionGap },
    sectionNote: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dim,
      marginBottom: hull.space.sm,
    },
    // An input is one of the two things DESIGN.md still lets a box wrap, and
    // the editor hangs under the row it belongs to rather than beside it.
    inlineEditor: { gap: hull.space.sm, paddingVertical: hull.space.sm },
    inlineEditorControls: { flexDirection: 'row', justifyContent: 'flex-end', gap: hull.space.sm },
    input: {
      ...Typography.default(),
      ...hull.type.body,
      minHeight: 44,
      paddingHorizontal: hull.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
      color: hull.textPrimary,
    },
    denied: {
      paddingVertical: hull.space.xxl,
      paddingHorizontal: hull.space.lg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.sm,
    },
    deniedTitle: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    errorPanel: {
      padding: hull.space.md,
      gap: hull.space.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
    },
    errorLabel: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
  };
});
