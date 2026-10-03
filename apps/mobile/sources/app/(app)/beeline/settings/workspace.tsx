import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SurfaceRefreshScheduler,
  isChatListView,
  isWorkspaceView,
  type BuzzClient,
  type ChatListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';

import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { WORKSPACE_PICTURES_ENABLED } from '@/buzz/photo-overrides';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { isWorkspaceOwnerRole } from '@/buzz/workspace-role';
import { MEMBERS_LABEL, ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { Button } from '@/components/buzz/Button';
import { PixelGateReveal } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { WORKSPACE_SETTINGS_TILE, workspacePictureSeat } from '@/buzz/workspace-tile';
import { Modal } from '@/modal';
import { PageHeader } from '@/components/buzz/PageHeader';
import { HullDialog } from '@/components/buzz/HullDialog';

type WorkspaceRoomSetting = {
  id: string;
  name: string;
  visibility: 'public' | 'invite-only';
  canManage: boolean;
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
        <TextInput
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

const WORKSPACE_VISIBILITY_LABELS = { public: 'Public', 'invite-only': 'Invite-only' } as const;
const ROOM_VISIBILITY_LABELS = { public: 'Open', 'invite-only': 'Invite-only' } as const;

/* The Workspace settings tile: the rail's tile at page scale, with its picture
 * seated by the same rule (`buzz/workspace-tile`). */
const PICTURE_TILE = WORKSPACE_SETTINGS_TILE;
const PICTURE_SEAT = workspacePictureSeat(PICTURE_TILE);

function roomCreatedQualifier(createdAt: number | undefined): string | undefined {
  if (createdAt === undefined) return undefined;
  const created = new Date(createdAt * 1_000);
  return `Created ${ROOM_DATE_FORMATTER.format(created)} · ${created.toISOString().slice(11, 19)} UTC`;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Workspace Settings, the Members page's sibling: one list of `SettingsRow`s
 * under small-caps section heads only where the page is a list (Rooms). The
 * workspace mark sits in a centred brass-bezelled tile; name, visibility and
 * the generated-mark reset are plain rows because the page is the workspace.
 */
export default function WorkspaceSettings() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const communityId = firstParam(params.communityId);
  const [client, setClient] = useState<BuzzClient | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [chatList, setChatList] = useState<ChatListView | null>(null);
  const [workspaceName, setWorkspaceName, workspaceDraft] = useTextDraft(`workspace-name:${communityId}`,
    '',
  );
  const [renamingWorkspace, setRenamingWorkspace] = useState(false);
  const [visibilityPickerOpen, setVisibilityPickerOpen] = useState(false);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText, deletionDraft] = useTextDraft(`workspace-delete:${communityId}`,
    '',
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const workspaceSchedulerRef = useRef<SurfaceRefreshScheduler<WorkspaceView> | null>(null);
  const chatsSchedulerRef = useRef<SurfaceRefreshScheduler<ChatListView> | null>(null);

  const workspace = workspaceView?.workspace;
  const canManageWorkspace = workspaceView?.viewer.permissions.manage === true;
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
      let unsubscribe: (() => void) | undefined;
      let workspaceScheduler: SurfaceRefreshScheduler<WorkspaceView> | undefined;
      let chatsScheduler: SurfaceRefreshScheduler<ChatListView> | undefined;
      setLoading(true);
      setClient(null);
      setWorkspaceView(null);
      setChatList(null);
      setError(null);
      void (async () => {
        if (!communityId) {
          setError('Workspace target is missing.');
          setLoading(false);
          return;
        }
        try {
          const currentIdentity = await loadBuzzIdentity();
          if (!currentIdentity) {
            router.replace('/beeline/onboarding');
            return;
          }
          const currentRelayUrl = await getEffectiveRelayUrl();
          const transport = new BuzzRigTransport(currentIdentity);
          const currentClient = await transport.ensureClient();
          if (cancelled) return;
          setClient(currentClient);
          const http = new RoomViewClient({ baseUrl: currentRelayUrl, identity: currentIdentity });
          workspaceScheduler = new SurfaceRefreshScheduler({
            fetch: () => http.workspace(communityId),
            apply: (value) => {
              setWorkspaceView(value);
              workspaceDraft.initialize(value.workspace.name);
              setLoading(false);
              setError(null);
            },
            onError: (reason) => {
              setLoading(false);
              setError(String(reason));
            },
          });
          chatsScheduler = new SurfaceRefreshScheduler({
            fetch: () => http.chats(communityId),
            apply: (value) => {
              setChatList(value);
              setError(null);
            },
            onError: (reason) => setError(String(reason)),
          });
          workspaceSchedulerRef.current = workspaceScheduler;
          chatsSchedulerRef.current = chatsScheduler;
          unsubscribe = await currentClient.surfaceSubscribe(
            [{ kinds: [9, 9000, 9001, 9007, 9008, 30078], '#h': [communityId] }],
            () => {
              workspaceScheduler?.signal();
              chatsScheduler?.signal();
            },
          );
          if (cancelled) return unsubscribe();
          await Promise.all([
            workspaceScheduler.startAfter(Promise.resolve()),
            chatsScheduler.startAfter(Promise.resolve()),
          ]);
        } catch (caught) {
          if (!cancelled) setError(`Could not load ${WORKSPACE_LABEL} settings: ${String(caught)}`);
        } finally {
          if (!cancelled && !workspaceScheduler) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
        unsubscribe?.();
        workspaceScheduler?.dispose();
        chatsScheduler?.dispose();
        workspaceSchedulerRef.current = null;
        chatsSchedulerRef.current = null;
      };
    }, [communityId, retryGeneration]),
  );

  const saveWorkspaceName = useCallback(async () => {
    if (!client || !communityId || !workspaceName.trim()) return;
    setWorkingKey('name');
    setError(null);
    const clearWorkspace = workspaceDraft.capture(false);
    try {
      await client.renameCommunity(communityId, workspaceName);
      clearWorkspace();
      workspaceSchedulerRef.current?.force();
      setRenamingWorkspace(false);
    } catch (caught) {
      setError(`Could not rename ${WORKSPACE_LABEL}: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId, workspaceName, workspaceDraft]);

  const changeWorkspacePicture = useCallback(async () => {
    if (!client || !communityId || !canManageWorkspace) return;
    setWorkingKey('picture');
    setError(null);
    try {
      const avatar = await pickAndUploadAvatar(client);
      if (!avatar) return;
      await client.setCommunityAvatar(communityId, avatar);
      workspaceSchedulerRef.current?.force();
    } catch (caught) {
      setError(`Could not set ${WORKSPACE_LABEL} picture: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [canManageWorkspace, client, communityId]);

  const resetWorkspacePicture = useCallback(async () => {
    if (!client || !communityId || !canManageWorkspace) return;
    setWorkingKey('picture');
    setError(null);
    try {
      await client.setCommunityAvatar(communityId, '');
      workspaceSchedulerRef.current?.force();
    } catch (caught) {
      setError(`Could not reset ${WORKSPACE_LABEL} picture: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [canManageWorkspace, client, communityId]);

  const changeWorkspaceVisibility = useCallback(
    async (visibility: 'public' | 'invite-only') => {
      setVisibilityPickerOpen(false);
      if (!client || !communityId || workspace?.visibility === visibility) return;
      setWorkingKey('visibility');
      setError(null);
      try {
        await client.setCommunityVisibility(communityId, visibility);
        workspaceSchedulerRef.current?.force();
      } catch (caught) {
        setError(`Could not change ${WORKSPACE_LABEL} visibility: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client, communityId, workspace?.visibility],
  );

  const changeRoomVisibility = useCallback(
    async (room: WorkspaceRoomSetting) => {
      if (!client || !room.canManage) return;
      if (!getBuzzRuntimeConfig().monolithEnabled) {
        setError(`${ROOM_LABEL} visibility requires the current Beeline runtime.`);
        return;
      }
      const visibility = room.visibility === 'public' ? 'invite-only' : 'public';
      setWorkingKey(`room-${room.id}`);
      setError(null);
      try {
        await monolithPhoneOperation('updateRoom', { roomId: room.id, visibility });
        workspaceSchedulerRef.current?.force();
        chatsSchedulerRef.current?.force();
      } catch (caught) {
        setError(`Could not change ${ROOM_LABEL} visibility: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client],
  );

  const showRoomDetails = useCallback((room: WorkspaceRoomSetting) => {
    // Display-only channel mark; the stored name and copied id stay raw.
    Modal.actionSheet(
      displayRoomIndexTitle(room.name) ?? room.name,
      [
        {
          text: `Copy ${ROOM_LABEL} ID`,
          metadata: room.id,
          onPress: () => {
            void Clipboard.setStringAsync(room.id);
          },
        },
      ],
      { cancelText: 'Cancel' },
    );
  }, []);

  const closeDeleteSheet = useCallback(() => {
    if (deleteBusy) return;
    setDeleteSheetOpen(false);
  }, [deleteBusy]);

  const confirmDeleteWorkspace = useCallback(async () => {
    if (!communityId || !workspace || deleteConfirmText.trim() !== workspace.name || deleteBusy)
      return;
    const clearDeletion = deletionDraft.capture();
    setDeleteBusy(true);
    setError(null);
    try {
      await monolithPhoneOperation('deleteWorkspace', { workspaceId: communityId });
      clearDeletion();
      setDeleteSheetOpen(false);
      router.replace('/beeline/channels');
    } catch (caught) {
      setError(`Could not delete ${WORKSPACE_LABEL}: ${String(caught)}`);
      setDeleteBusy(false);
    }
  }, [communityId, deleteBusy, deleteConfirmText, workspace, deletionDraft]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <SurfaceGlyphLoader testID="workspace-settings-loader" />
      </View>
    );
  }

  const peopleTotal = workspaceView?.peopleTotal;
  const agentTotal = workspaceView?.agentTotal;
  const memberCount =
    peopleTotal === undefined || agentTotal === undefined ? undefined : peopleTotal + agentTotal;
  const pictureAction =
    workingKey === 'picture' ? 'Working…' : workspace?.avatar ? 'Change picture' : 'Set picture';

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <PageHeader onBack={() => router.back()} prominent title={WORKSPACE_LABEL} />

      {!workspaceView ? (
        <View style={styles.denied} testID="workspace-settings-load-failed">
          <Text style={styles.deniedTitle}>
            {error ?? `Could not load ${WORKSPACE_LABEL} settings`}
          </Text>
          <Button
            label="RETRY"
            onPress={() => setRetryGeneration((value) => value + 1)}
            testID="workspace-settings-retry"
          />
        </View>
      ) : !canManageWorkspace ? (
        <View style={styles.denied} testID="workspace-settings-denied">
          <Text style={styles.deniedGlyph}>⌁</Text>
          <Text style={styles.deniedTitle}>Admin access required</Text>
          <Text style={styles.deniedBody}>
            Only this {WORKSPACE_LABEL}&apos;s owners and admins can see or change its settings.
          </Text>
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.section} testID="workspace-overview-settings">
            <View style={styles.ident}>
              {WORKSPACE_PICTURES_ENABLED ? (
                <TouchableOpacity
                  accessibilityLabel={`${pictureAction} for this ${WORKSPACE_LABEL}`}
                  accessibilityRole="button"
                  disabled={workingKey === 'picture'}
                  onPress={() => void changeWorkspacePicture()}
                  style={styles.tile}
                  testID="workspace-picture-change"
                >
                  <View style={styles.pictureSeat}>
                    <IdentityMark
                      kind="workspace"
                      seed={workspace?.id ?? 'workspace-loading'}
                      avatarUrl={workspace?.avatar}
                      name={workspace?.name}
                      size={PICTURE_SEAT.pictureSize}
                      testID="workspace-picture-mark"
                    />
                  </View>
                </TouchableOpacity>
              ) : (
                <View style={styles.tile}>
                  <View style={styles.pictureSeat}>
                    <IdentityMark
                      kind="workspace"
                      seed={workspace?.id ?? 'workspace-loading'}
                      avatarUrl={workspace?.avatar}
                      name={workspace?.name}
                      size={PICTURE_SEAT.pictureSize}
                      testID="workspace-picture-mark"
                    />
                  </View>
                </View>
              )}
              <Text style={styles.workspaceName}>{workspace?.name ?? WORKSPACE_LABEL}</Text>
            </View>
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
            />
            {renamingWorkspace && (
              <View style={styles.inlineEditor} testID="workspace-name-editor">
                <TextInput
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
                <View style={styles.inlineEditorControls}>
                  <Button
                    disabled={workingKey === 'name'}
                    label="Cancel"
                    onPress={() => setRenamingWorkspace(false)}
                    variant="secondary"
                  />
                  <Button
                    disabled={
                      !workspaceName.trim() ||
                      workspaceName.trim() === workspace?.name ||
                      workingKey === 'name'
                    }
                    label={workingKey === 'name' ? 'Saving…' : 'Save'}
                    loading={workingKey === 'name'}
                    onPress={() => void saveWorkspaceName()}
                    testID="workspace-name-save"
                  />
                </View>
              </View>
            )}
            <View testID="workspace-visibility-setting">
              <SettingsRow
                accessibilityLabel={`Change who can find this ${WORKSPACE_LABEL}`}
                chevron="right"
                disabled={workingKey === 'visibility'}
                onPress={() => setVisibilityPickerOpen(true)}
                testID="workspace-visibility-row"
                title="Visibility"
                value={
                  workspace?.visibility
                    ? WORKSPACE_VISIBILITY_LABELS[workspace.visibility]
                    : undefined
                }
              />
            </View>
            {WORKSPACE_PICTURES_ENABLED && workspace?.avatar ? (
              <SettingsRow
                disabled={workingKey === 'picture'}
                onPress={() => void resetWorkspacePicture()}
                testID="workspace-picture-clear"
                title="Use generated mark"
                tone="action"
              />
            ) : null}
          </View>

          <View style={styles.section} testID="workspace-members-link">
            <SettingsRow
              chevron="right"
              description="Invite people, connect agents, and manage roles."
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

          <View style={styles.section} testID="channel-visibility-settings">
            <Text style={styles.sectionLabel}>{ROOM_LABEL}s</Text>
            {workspaceView?.managerSettings?.roomsTruncated && (
              <Text style={styles.sectionNote} testID="room-visibility-truncated">
                Showing the first 200 {ROOM_LABEL}s.
              </Text>
            )}
            {rooms.map((room) => {
              const displayName = displayRoomIndexTitle(room.name) ?? room.name;
              const duplicateName = duplicateRoomNames.has(room.name.trim().toLocaleLowerCase());
              const nextVisibility = room.visibility === 'public' ? 'invite-only' : 'public';
              const nextVisibilityLabel = ROOM_VISIBILITY_LABELS[nextVisibility];
              return (
                <View key={room.id}>
                  <SettingsRow
                    accessibilityLabel={`Set ${displayName} visibility to ${nextVisibilityLabel}`}
                    chevron="right"
                    description={duplicateName ? roomCreatedQualifier(room.createdAt) : undefined}
                    descriptionAction={
                      duplicateName
                        ? {
                            accessibilityLabel: `View details for ${ROOM_LABEL} ${displayName}`,
                            label: 'Details',
                            onPress: () => showRoomDetails(room),
                            testID: `room-details-${room.id}`,
                          }
                        : undefined
                    }
                    disabled={!room.canManage || workingKey === `room-${room.id}`}
                    onPress={() => void changeRoomVisibility(room)}
                    testID={`room-visibility-${room.id}`}
                    title={displayName}
                    value={ROOM_VISIBILITY_LABELS[room.visibility]}
                  />
                </View>
              );
            })}
          </View>

          {isWorkspaceOwner && (
            <View style={styles.section}>
              <SettingsRow
                accessibilityLabel={`Delete this ${WORKSPACE_LABEL}`}
                onPress={() => setDeleteSheetOpen(true)}
                testID="workspace-delete-row"
                title={`Delete ${WORKSPACE_LABEL}`}
                tone="destructive"
              />
            </View>
          )}

          {error && (
            <PixelGateReveal accessibilityRole="alert" style={styles.errorPanel}>
              <Text style={styles.errorLabel}>! Error</Text>
              <Text style={styles.errorText}>{error}</Text>
            </PixelGateReveal>
          )}

          <Text style={styles.quiet} testID="workspace-census">
            {`${rooms.length} ${
              rooms.length === 1 ? ROOM_LABEL.toLowerCase() : `${ROOM_LABEL.toLowerCase()}s`
            }${
              memberCount === undefined
                ? ''
                : ` · ${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
            }`}
          </Text>
        </ScrollView>
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
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center' },
    content: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    ident: {
      alignItems: 'center',
      gap: hull.space.md,
      paddingTop: hull.space.sm,
      paddingBottom: hull.space.lg,
    },
    tile: {
      width: PICTURE_TILE.size,
      height: PICTURE_TILE.size,
      borderRadius: PICTURE_TILE.radius,
      borderWidth: PICTURE_TILE.borderWidth,
      borderColor: hull.accent,
      backgroundColor: hull.avatarGround,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /* The picture's seat: it rounds the picture's own corners, so the bezel
     * never has to crop them. Concentric curves, one even slab of tile. */
    pictureSeat: {
      width: PICTURE_SEAT.pictureSize,
      height: PICTURE_SEAT.pictureSize,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: PICTURE_SEAT.pictureRadius,
      overflow: 'hidden',
    },
    workspaceName: {
      ...Typography.default(),
      ...hull.type.bodyStrong,
      color: hull.textPrimary,
      textAlign: 'center',
    },
    section: {},
    sectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      paddingRight: hull.space.sm,
      paddingBottom: hull.space.xs,
      color: hull.textMuted,
    },
    sectionNote: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dim,
      marginBottom: 8,
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
      flex: 1,
      paddingHorizontal: hull.space.lg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.sm,
    },
    deniedGlyph: { ...Typography.default(), ...hull.type.hero, color: hull.steel },
    deniedTitle: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    deniedBody: {
      ...Typography.default(),
      ...hull.type.meta,
      maxWidth: 360,
      color: hull.textSecondary,
      textAlign: 'center',
    },
    errorPanel: {
      padding: hull.space.md,
      gap: hull.space.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
    },
    errorLabel: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    quiet: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
      paddingTop: hull.space.md,
      paddingBottom: hull.space.sm,
    },
  };
});
