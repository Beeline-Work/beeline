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
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { MEMBERS_LABEL, ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { MonoButton, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { Modal } from '@/modal';

type WorkspaceRoomSetting = {
  id: string;
  name: string;
  visibility: 'public' | 'invite-only';
  canManage: boolean;
  createdAt: number;
};

const ROOM_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const VISIBILITY_LABELS = { public: 'Public', 'invite-only': 'Invite-only' } as const;

function roomCreatedQualifier(createdAt: number): string {
  const created = new Date(createdAt * 1_000);
  return `Created ${ROOM_DATE_FORMATTER.format(created)} · ${created.toISOString().slice(11, 19)} UTC`;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Workspace Settings, the Members page's sibling: one list of `SettingsRow`s
 * under small-caps section heads, values off the titles, and one trailing
 * vocabulary per row. What used to be a picture slab, a boxed name field over
 * a full-width commit plate, and a question with a paragraph and two toggle
 * boxes is now four rows — the last of which opens the visibility picker as an
 * ordinary Hull sheet, where its one line of explanation lives.
 */
export default function WorkspaceSettings() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const communityId = firstParam(params.communityId);
  const [client, setClient] = useState<BuzzClient | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [chatList, setChatList] = useState<ChatListView | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [renamingWorkspace, setRenamingWorkspace] = useState(false);
  const [visibilityPickerOpen, setVisibilityPickerOpen] = useState(false);
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const workspaceSchedulerRef = useRef<SurfaceRefreshScheduler<WorkspaceView> | null>(null);
  const chatsSchedulerRef = useRef<SurfaceRefreshScheduler<ChatListView> | null>(null);

  const workspace = workspaceView?.workspace;
  const canManageWorkspace = workspaceView?.viewer.permissions.manage ?? false;
  const rooms = useMemo<WorkspaceRoomSetting[]>(
    () =>
      (chatList?.chats ?? [])
        .filter((item) => !item.room.archived)
        .map((item) => ({
          id: item.room.id,
          name: item.room.name,
          visibility: item.room.visibility ?? 'invite-only',
          canManage: canManageWorkspace,
          createdAt: item.room.createdAt,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [canManageWorkspace, chatList],
  );
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
          const transport = new BuzzRigTransport(currentIdentity, currentRelayUrl);
          const currentClient = await transport.ensureClient();
          if (cancelled) return;
          setClient(currentClient);
          const http = new RoomViewClient({ baseUrl: currentRelayUrl, identity: currentIdentity });
          workspaceScheduler = new SurfaceRefreshScheduler({
            fetch: () => http.workspace(communityId),
            apply: (value) => {
              setWorkspaceView(value);
              setWorkspaceName((current) => current || value.workspace.name);
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
    }, [communityId]),
  );

  const saveWorkspaceName = useCallback(async () => {
    if (!client || !communityId || !workspaceName.trim()) return;
    setWorkingKey('name');
    setError(null);
    try {
      await client.renameCommunity(communityId, workspaceName);
      workspaceSchedulerRef.current?.force();
      setRenamingWorkspace(false);
    } catch (caught) {
      setError(`Could not rename ${WORKSPACE_LABEL}: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId, workspaceName]);

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
      const visibility = room.visibility === 'public' ? 'invite-only' : 'public';
      setWorkingKey(`room-${room.id}`);
      setError(null);
      try {
        await client.setChannelVisibility(room.id, visibility);
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

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
      </View>
    );
  }

  const pictureAction =
    workingKey === 'picture' ? 'Working…' : workspace?.avatar ? 'Change' : 'Set picture';

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.eyebrow}>
            {workspace?.name ?? WORKSPACE_LABEL}
          </Text>
          <Text style={styles.title}>{WORKSPACE_LABEL}</Text>
        </View>
      </View>

      {!canManageWorkspace ? (
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
            <Text style={styles.sectionLabel}>{WORKSPACE_LABEL}</Text>
            {WORKSPACE_PICTURES_ENABLED && (
              <>
                <SettingsRow
                  accessibilityLabel={`${pictureAction} for this ${WORKSPACE_LABEL}`}
                  action={pictureAction}
                  disabled={workingKey === 'picture'}
                  leading={
                    <IdentityMark
                      kind="workspace"
                      seed={workspace?.id ?? 'workspace-loading'}
                      avatarUrl={workspace?.avatar}
                      name={workspace?.name}
                      size={38}
                    />
                  }
                  onPress={() => void changeWorkspacePicture()}
                  testID="workspace-picture-change"
                  title="Picture"
                />
                {workspace?.avatar && (
                  <SettingsRow
                    disabled={workingKey === 'picture'}
                    onPress={() => void resetWorkspacePicture()}
                    testID="workspace-picture-clear"
                    title="Use generated mark"
                    tone="action"
                  />
                )}
              </>
            )}
            <SettingsRow
              accessibilityLabel={`${WORKSPACE_LABEL} name`}
              chevron={renamingWorkspace ? 'down' : 'right'}
              onPress={() => {
                setWorkspaceName(workspace?.name ?? '');
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
                  <MonoButton
                    disabled={workingKey === 'name'}
                    label="Cancel"
                    onPress={() => setRenamingWorkspace(false)}
                    variant="secondary"
                  />
                  <MonoButton
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
          </View>

          <View style={styles.section} testID="workspace-visibility-setting">
            <Text style={styles.sectionLabel}>Visibility</Text>
            <SettingsRow
              accessibilityLabel={`Change who can find this ${WORKSPACE_LABEL}`}
              chevron="right"
              disabled={workingKey === 'visibility'}
              onPress={() => setVisibilityPickerOpen(true)}
              testID="workspace-visibility-row"
              title="Visibility"
              value={
                workspace?.visibility ? VISIBILITY_LABELS[workspace.visibility] : 'Invite-only'
              }
            />
          </View>

          <View style={styles.section} testID="workspace-members-link">
            <Text style={styles.sectionLabel}>{MEMBERS_LABEL}</Text>
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
            />
          </View>

          <View style={styles.section} testID="channel-visibility-settings">
            <Text style={styles.sectionLabel}>{ROOM_LABEL} visibility</Text>
            <SettingsRow
              chevron="right"
              description="Create, rename, archive, and manage participants."
              onPress={() =>
                router.push({ pathname: '/beeline/channels', params: { communityId } } as Href)
              }
              testID="open-rooms"
              title={`${ROOM_LABEL}s`}
            />
            {rooms.map((room) => {
              const displayName = displayRoomIndexTitle(room.name) ?? room.name;
              const duplicateName = duplicateRoomNames.has(room.name.trim().toLocaleLowerCase());
              const nextVisibility = room.visibility === 'public' ? 'invite-only' : 'public';
              return (
                <SettingsRow
                  accessibilityLabel={`Open ${ROOM_LABEL} ${displayName}`}
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
                  chevron="right"
                  key={room.id}
                  onPress={() =>
                    router.push(`/beeline/chat/${encodeURIComponent(room.id)}` as Href)
                  }
                  title={displayName}
                  trailingPress={{
                    accessibilityLabel: `Make ${displayName} ${nextVisibility}`,
                    disabled: !room.canManage || workingKey === `room-${room.id}`,
                    onPress: () => void changeRoomVisibility(room),
                    testID: `room-visibility-${room.id}`,
                  }}
                  value={VISIBILITY_LABELS[room.visibility]}
                />
              );
            })}
          </View>

          {error && (
            <PixelGateReveal accessibilityRole="alert" style={styles.errorPanel}>
              <Text style={styles.errorLabel}>! Error</Text>
              <Text style={styles.errorText}>{error}</Text>
            </PixelGateReveal>
          )}
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
            label={VISIBILITY_LABELS[visibility]}
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center' },
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    headerCopy: { flex: 1, minWidth: 0 },
    eyebrow: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    content: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    section: {},
    sectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      paddingRight: hull.space.sm,
      paddingBottom: hull.space.xs,
      color: hull.textMuted,
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
  };
});
