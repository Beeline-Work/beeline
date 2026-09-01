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
import { MEMBERS_GLYPH, MEMBERS_LABEL, ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { MonoButton, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { SettingsNavigationRow } from '@/components/buzz/SettingsNavigationRow';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';
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

function roomCreatedQualifier(createdAt: number): string {
  const created = new Date(createdAt * 1_000);
  return `Created ${ROOM_DATE_FORMATTER.format(created)} · ${created.toISOString().slice(11, 19)} UTC`;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function WorkspaceSettings() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const communityId = firstParam(params.communityId);
  const [client, setClient] = useState<BuzzClient | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [chatList, setChatList] = useState<ChatListView | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
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
          <Text style={styles.title}>{WORKSPACE_LABEL}</Text>
          <Text numberOfLines={1} style={styles.headerMeta}>
            {workspace?.name ?? WORKSPACE_LABEL}
          </Text>
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
            <Text style={styles.sectionLabel}>WORKSPACE</Text>
            {WORKSPACE_PICTURES_ENABLED && (
              <View style={styles.workspaceIdentityRow}>
                <IdentityMark
                  kind="workspace"
                  seed={workspace?.id ?? 'workspace-loading'}
                  avatarUrl={workspace?.avatar}
                  name={workspace?.name}
                  size={72}
                />
                <View style={styles.workspaceIdentityCopy}>
                  <Text style={styles.sectionTitle}>Picture</Text>
                  <View style={styles.inlineActions}>
                    <TouchableOpacity
                      disabled={workingKey === 'picture'}
                      onPress={() => void changeWorkspacePicture()}
                      style={styles.textButton}
                      testID="workspace-picture-change"
                    >
                      <Text style={styles.textButtonLabel}>
                        {workingKey === 'picture'
                          ? 'Working…'
                          : workspace?.avatar
                            ? 'Change'
                            : 'Set picture'}
                      </Text>
                    </TouchableOpacity>
                    {workspace?.avatar && (
                      <TouchableOpacity
                        disabled={workingKey === 'picture'}
                        onPress={() => void resetWorkspacePicture()}
                        style={styles.textButton}
                        testID="workspace-picture-clear"
                      >
                        <Text style={styles.textButtonLabel}>Use generated mark</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>
            )}
            <TextInput
              accessibilityLabel={`${WORKSPACE_LABEL} name`}
              editable={workingKey !== 'name'}
              maxLength={80}
              onChangeText={setWorkspaceName}
              onSubmitEditing={() => void saveWorkspaceName()}
              placeholder={`${WORKSPACE_LABEL} name`}
              placeholderTextColor={theme.buzz.dim}
              style={styles.input}
              testID="workspace-name-input"
              value={workspaceName}
            />
            <MonoButton
              disabled={!workspaceName.trim() || workspaceName.trim() === workspace?.name}
              label="Save name"
              loading={workingKey === 'name'}
              onPress={() => void saveWorkspaceName()}
              style={styles.primaryAction}
            />
          </View>

          <View style={styles.section} testID="workspace-visibility-setting">
            <Text style={styles.sectionLabel}>VISIBILITY</Text>
            <Text style={styles.sectionTitle}>Who can find this {WORKSPACE_LABEL}?</Text>
            <Text style={styles.sectionBody}>
              Invite-only keeps discovery closed. Existing members keep their access.
            </Text>
            <View style={styles.segmented}>
              {(['public', 'invite-only'] as const).map((visibility) => {
                const selected = workspace?.visibility === visibility;
                return (
                  <TouchableOpacity
                    accessibilityState={{ selected }}
                    disabled={workingKey === 'visibility'}
                    key={visibility}
                    onPress={() => void changeWorkspaceVisibility(visibility)}
                    style={[styles.segment, selected && styles.segmentSelected]}
                    testID={`workspace-visibility-${visibility}`}
                  >
                    <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                      {visibility === 'public' ? 'PUBLIC' : 'INVITE-ONLY'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.section} testID="workspace-members-link">
            <Text style={styles.sectionLabel}>
              {MEMBERS_GLYPH} {MEMBERS_LABEL.toUpperCase()}
            </Text>
            <SettingsNavigationRow
              glyph={MEMBERS_GLYPH}
              label={MEMBERS_LABEL}
              supportingCopy="Invite people, connect agents, and manage roles."
              onPress={() =>
                router.push({
                  pathname: '/beeline/members',
                  params: { communityId },
                } as unknown as Href)
              }
              testID="open-members"
            />
          </View>

          <View style={styles.section} testID="channel-visibility-settings">
            <Text style={styles.sectionLabel}>{ROOM_LABEL.toUpperCase()} VISIBILITY</Text>
            <SettingsNavigationRow
              glyph={<RoomGlyph color={theme.buzz.chrome} size={18} />}
              label={`${ROOM_LABEL}s`}
              supportingCopy="Create, rename, archive, and manage participants."
              onPress={() =>
                router.push({ pathname: '/beeline/channels', params: { communityId } } as Href)
              }
              testID="open-rooms"
            />
            {rooms.map((room) => {
              const duplicateName = duplicateRoomNames.has(room.name.trim().toLocaleLowerCase());
              const nextVisibility = room.visibility === 'public' ? 'invite-only' : 'public';
              return (
                <View key={room.id} style={styles.roomRow}>
                  <View accessibilityElementsHidden style={styles.roomMark}>
                    <RoomGlyph color={theme.buzz.chrome} size={18} />
                  </View>
                  <View style={styles.roomCopy}>
                    <TouchableOpacity
                      accessibilityLabel={`Open ${ROOM_LABEL} ${
                        displayRoomIndexTitle(room.name) ?? room.name
                      }`}
                      accessibilityRole="button"
                      onPress={() =>
                        router.push(`/beeline/chat/${encodeURIComponent(room.id)}` as Href)
                      }
                      style={styles.roomLink}
                    >
                      <Text numberOfLines={1} style={styles.roomName}>
                        {displayRoomIndexTitle(room.name) ?? room.name}
                      </Text>
                    </TouchableOpacity>
                    {duplicateName && (
                      <View style={styles.roomQualifierRow}>
                        <Text numberOfLines={1} style={styles.roomQualifier}>
                          {roomCreatedQualifier(room.createdAt)}
                        </Text>
                        <TouchableOpacity
                          accessibilityLabel={`View details for ${ROOM_LABEL} ${
                            displayRoomIndexTitle(room.name) ?? room.name
                          }`}
                          accessibilityRole="button"
                          onPress={() => showRoomDetails(room)}
                          style={styles.roomDetailsButton}
                          testID={`room-details-${room.id}`}
                        >
                          <Text style={styles.roomDetailsText}>DETAILS</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                  <TouchableOpacity
                    accessibilityLabel={`Make ${displayRoomIndexTitle(room.name) ?? room.name} ${nextVisibility}`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !room.canManage }}
                    disabled={!room.canManage || workingKey === `room-${room.id}`}
                    onPress={() => void changeRoomVisibility(room)}
                    style={[styles.visibilityButton, !room.canManage && styles.disabledButton]}
                    testID={`room-visibility-${room.id}`}
                  >
                    <Text style={styles.visibilityButtonText}>
                      {room.visibility === 'public' ? 'PUBLIC' : 'INVITE-ONLY'}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>

          {error && (
            <PixelGateReveal accessibilityRole="alert" style={styles.errorPanel}>
              <Text style={styles.errorLabel}>! ERROR</Text>
              <Text style={styles.errorText}>{error}</Text>
            </PixelGateReveal>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: groknight.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center' },
    header: {
      minHeight: 66,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    backText: { ...Typography.default(), color: groknight.chrome, fontSize: 30, lineHeight: 34 },
    headerCopy: { flex: 1, minWidth: 0, paddingRight: 44 },
    title: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
      fontSize: 18,
    },
    headerMeta: {
      ...Typography.mono('semiBold'),
      marginTop: 3,
      color: groknight.textMuted,
      fontSize: 9,
      letterSpacing: 0.7,
    },
    content: { paddingHorizontal: 18, paddingTop: 24, paddingBottom: 48 },
    section: {
      paddingBottom: 28,
      marginBottom: 28,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
    },
    sectionLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 10,
      letterSpacing: 0.8,
    },
    sectionTitle: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      marginTop: 8,
      color: groknight.textPrimary,
      fontSize: 17,
    },
    sectionBody: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      marginTop: 7,
      color: groknight.textSecondary,
      fontSize: 12,
      lineHeight: 18,
    },
    workspaceIdentityRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 14 },
    workspaceIdentityCopy: { flex: 1, minWidth: 0 },
    inlineActions: { marginTop: 4, flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
    input: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      minHeight: 48,
      marginTop: 14,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: groknight.border,
      borderRadius: groknight.radius,
      color: groknight.textPrimary,
      backgroundColor: groknight.bgBase,
      fontSize: 14,
    },
    primaryAction: { marginTop: 10 },
    textButton: {
      minHeight: 44,
      paddingHorizontal: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    textButtonLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 10,
      letterSpacing: 0.6,
    },
    segmented: { marginTop: 14, flexDirection: 'row', gap: 8 },
    segment: {
      flex: 1,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.border,
      borderRadius: groknight.radius,
      backgroundColor: groknight.bgBase,
    },
    segmentSelected: {
      borderColor: groknight.selectedBorder,
      backgroundColor: groknight.bgHighlight,
    },
    segmentText: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 10,
      letterSpacing: 0.5,
    },
    segmentTextSelected: { color: groknight.textPrimary },
    addMemberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    memberInput: { flex: 1, minWidth: 0 },
    compactAction: {
      minWidth: 58,
      minHeight: 48,
      marginTop: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: groknight.radius,
      backgroundColor: groknight.actionFill,
    },
    compactActionText: {
      ...Typography.mono('semiBold'),
      color: groknight.textInverted,
      fontSize: 10,
      letterSpacing: 0.7,
    },
    memberList: { marginTop: 14, borderBottomWidth: 1, borderBottomColor: groknight.border },
    memberRow: {
      minHeight: 94,
      paddingHorizontal: 10,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    memberCopy: { flex: 1, minWidth: 0 },
    memberName: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
      fontSize: 13,
    },
    memberHandle: { ...Typography.mono(), marginTop: 2, color: groknight.textMuted, fontSize: 9 },
    roleRow: { marginTop: 7, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
    roleButton: {
      minHeight: 30,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.border,
      borderRadius: groknight.radius,
    },
    roleButtonSelected: {
      borderColor: groknight.selectedBorder,
      backgroundColor: groknight.bgHighlight,
    },
    roleText: { ...Typography.mono('semiBold'), color: groknight.textMuted, fontSize: 8 },
    roleTextSelected: { color: groknight.textPrimary },
    removeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    removeText: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      color: groknight.steel,
      fontSize: 22,
    },
    inviteRow: {
      minHeight: 62,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      backgroundColor: groknight.bgBase,
    },
    settingCopy: { flex: 1, minWidth: 0, paddingVertical: 10 },
    inviteTitle: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 10,
      letterSpacing: 0.5,
    },
    inviteMeta: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      marginTop: 4,
      color: groknight.textMuted,
      fontSize: 10,
    },
    roomRow: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderTopColor: groknight.border,
    },
    roomMark: {
      width: 30,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roomCopy: { flex: 1, minWidth: 0, paddingHorizontal: 10 },
    roomLink: { minHeight: 44, justifyContent: 'center' },
    roomName: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
      fontSize: 13,
    },
    roomQualifierRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center' },
    roomQualifier: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      flex: 1,
      minWidth: 0,
      color: groknight.textMuted,
      fontSize: 10,
      lineHeight: 14,
    },
    roomDetailsButton: {
      minWidth: 54,
      minHeight: 44,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    roomDetailsText: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 8,
      letterSpacing: 0.5,
    },
    visibilityButton: {
      minWidth: 88,
      minHeight: 44,
      paddingHorizontal: 9,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      borderRadius: groknight.radius,
    },
    disabledButton: { opacity: 0.45 },
    visibilityButtonText: {
      ...Typography.mono('semiBold'),
      color: groknight.textSecondary,
      fontSize: 8,
    },
    denied: { flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
    deniedGlyph: { ...Typography.default(), color: groknight.steel, fontSize: 34 },
    deniedTitle: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      marginTop: 14,
      color: groknight.textPrimary,
      fontSize: 18,
    },
    deniedBody: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      maxWidth: 360,
      marginTop: 8,
      color: groknight.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
    },
    errorPanel: {
      padding: 12,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    errorLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 10,
      letterSpacing: 0.7,
    },
    errorText: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      marginTop: 4,
      color: groknight.textSecondary,
      fontSize: 12,
      lineHeight: 17,
    },
  };
});
