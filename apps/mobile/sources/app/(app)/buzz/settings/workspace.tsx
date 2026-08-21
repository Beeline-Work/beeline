import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
  tagValue,
  tagValues,
  type BuzzClient,
  type Community,
} from '@beeline/buzz-client';

import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { MEMBERS_GLYPH, MEMBERS_LABEL, ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { HullSurface, MonoButton, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import { IdentityMark } from '@/components/buzz/IdentityMark';

type WorkspaceRoomSetting = {
  id: string;
  name: string;
  visibility: 'public' | 'invite-only';
  canManage: boolean;
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function loadWorkspaceRooms(
  client: BuzzClient,
  communityId: string,
  viewerPubkey: string,
): Promise<WorkspaceRoomSetting[]> {
  const creates = await client.query([{ kinds: [KIND_CREATE_GROUP], limit: 500 }]);
  const roomCreates = new Map<string, (typeof creates)[number]>();
  for (const create of creates) {
    if (tagValue(create, TAG_COMMUNITY) !== communityId) continue;
    if (tagValue(create, TAG_PARENT) || tagValues(create, 't').includes(TAG_DIRECT_MESSAGE)) continue;
    const id = tagValue(create, 'h') ?? tagValue(create, 'd');
    if (!id || id === communityId) continue;
    const current = roomCreates.get(id);
    if (!current || create.created_at < current.created_at) roomCreates.set(id, create);
  }
  const rooms = await Promise.all(
    [...roomCreates.entries()].map(async ([id, create]) => {
      const [metadata, role] = await Promise.all([
        client.getChannelMetadata(id),
        client.getChannelRole(id, viewerPubkey),
      ]);
      const createdVisibility = tagValue(create, 'visibility');
      return {
        id,
        name: metadata?.name ?? tagValue(create, 'name') ?? `${ROOM_LABEL} ${id.slice(0, 8)}`,
        visibility:
          metadata?.visibility ??
          (createdVisibility === 'private' || createdVisibility === 'invite-only'
            ? 'invite-only'
            : 'public'),
        canManage: isWorkspaceManagerRole(role),
      } satisfies WorkspaceRoomSetting;
    }),
  );
  return rooms.sort((a, b) => a.name.localeCompare(b.name));
}

export default function WorkspaceSettings() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const communityId = firstParam(params.communityId);
  const [client, setClient] = useState<BuzzClient | null>(null);
  const [community, setCommunity] = useState<Community | null>(null);
  const [rooms, setRooms] = useState<WorkspaceRoomSetting[]>([]);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canManageWorkspace = isWorkspaceManagerRole(community?.viewerRole);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      setClient(null);
      setCommunity(null);
      setRooms([]);
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
            router.replace('/buzz/onboarding');
            return;
          }
          const currentRelayUrl = await getEffectiveRelayUrl();
          const transport = new BuzzRigTransport(currentIdentity, currentRelayUrl);
          const currentClient = await transport.ensureClient();
          const [nextCommunity, allMembers] = await Promise.all([
            currentClient.getCommunity(communityId),
            currentClient.communityMembers(communityId),
          ]);
          if (!nextCommunity) throw new Error('Workspace not found.');
          const viewerRole = allMembers.find(
            (member) => member.pubkey === currentIdentity.publicKey,
          )?.role;
          const scopedCommunity = { ...nextCommunity, ...(viewerRole ? { viewerRole } : {}) };
          if (cancelled) return;
          setClient(currentClient);
          setCommunity(scopedCommunity);
          setWorkspaceName(scopedCommunity.name);
          if (!isWorkspaceManagerRole(viewerRole)) return;

          const nextRooms = await loadWorkspaceRooms(currentClient, communityId, currentIdentity.publicKey);
          if (!cancelled) {
            setRooms(nextRooms);
          }
        } catch (caught) {
          if (!cancelled) setError(`Could not load ${WORKSPACE_LABEL} settings: ${String(caught)}`);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [communityId]),
  );

  const saveWorkspaceName = useCallback(async () => {
    if (!client || !communityId || !workspaceName.trim()) return;
    setWorkingKey('name');
    setError(null);
    try {
      const updated = await client.renameCommunity(communityId, workspaceName);
      setCommunity((current) => ({ ...updated, ...(current?.viewerRole ? { viewerRole: current.viewerRole } : {}) }));
      setWorkspaceName(updated.name);
    } catch (caught) {
      setError(`Could not rename ${WORKSPACE_LABEL}: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId, workspaceName]);

  const changeWorkspacePicture = useCallback(async () => {
    if (!client || !communityId) return;
    setWorkingKey('picture');
    setError(null);
    try {
      const avatar = await pickAndUploadAvatar(client);
      if (!avatar) return;
      const updated = await client.setCommunityAvatar(communityId, avatar);
      setCommunity((current) => ({ ...updated, ...(current?.viewerRole ? { viewerRole: current.viewerRole } : {}) }));
    } catch (caught) {
      setError(`Could not set ${WORKSPACE_LABEL} picture: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId]);

  const resetWorkspacePicture = useCallback(async () => {
    if (!client || !communityId) return;
    setWorkingKey('picture');
    setError(null);
    try {
      const updated = await client.setCommunityAvatar(communityId, '');
      setCommunity((current) => ({ ...updated, ...(current?.viewerRole ? { viewerRole: current.viewerRole } : {}) }));
    } catch (caught) {
      setError(`Could not reset ${WORKSPACE_LABEL} picture: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId]);

  const changeWorkspaceVisibility = useCallback(
    async (visibility: Community['visibility']) => {
      if (!client || !communityId || community?.visibility === visibility) return;
      setWorkingKey('visibility');
      setError(null);
      try {
        const updated = await client.setCommunityVisibility(communityId, visibility);
        setCommunity((current) => ({ ...updated, ...(current?.viewerRole ? { viewerRole: current.viewerRole } : {}) }));
      } catch (caught) {
        setError(`Could not change ${WORKSPACE_LABEL} visibility: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client, community?.visibility, communityId],
  );

  const changeRoomVisibility = useCallback(
    async (room: WorkspaceRoomSetting) => {
      if (!client || !room.canManage) return;
      const visibility = room.visibility === 'public' ? 'invite-only' : 'public';
      setWorkingKey(`room-${room.id}`);
      setError(null);
      try {
        const metadata = await client.setChannelVisibility(room.id, visibility);
        setRooms((current) =>
          current.map((item) =>
            item.id === room.id ? { ...item, visibility: metadata.visibility ?? visibility } : item,
          ),
        );
      } catch (caught) {
        setError(`Could not change ${ROOM_LABEL} visibility: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <HullSurface strength="quiet" style={styles.header}>
        <TouchableOpacity accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{WORKSPACE_LABEL} Settings</Text>
          <Text numberOfLines={1} style={styles.headerMeta}>
            {community?.name ?? WORKSPACE_LABEL}
          </Text>
        </View>
      </HullSurface>

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
            <View style={styles.workspaceIdentityRow}>
              <IdentityMark
                kind="workspace"
                seed={community?.communityId ?? 'workspace-loading'}
                avatarUrl={community?.avatar}
                name={community?.name}
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
                      {workingKey === 'picture' ? 'Working…' : community?.avatar ? 'Change' : 'Set picture'}
                    </Text>
                  </TouchableOpacity>
                  {community?.avatar && (
                    <TouchableOpacity
                      disabled={workingKey === 'picture'}
                      onPress={() => void resetWorkspacePicture()}
                      style={styles.textButton}
                    >
                      <Text style={styles.textButtonLabel}>Use generated mark</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
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
              disabled={!workspaceName.trim() || workspaceName.trim() === community?.name}
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
                const selected = community?.visibility === visibility;
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
            <Text style={styles.sectionBody}>
              Invite people, connect agents, and manage member roles in one place.
            </Text>
            <MonoButton
              label={`${MEMBERS_GLYPH} OPEN ${MEMBERS_LABEL.toUpperCase()}`}
              onPress={() =>
                router.push(
                  { pathname: '/buzz/members', params: { communityId } } as unknown as Href,
                )
              }
              style={styles.primaryAction}
              testID="open-members"
            />
          </View>

          <View style={styles.section} testID="channel-visibility-settings">
            <Text style={styles.sectionLabel}>CHANNEL VISIBILITY</Text>
            <Text style={styles.sectionBody}>
              Creation, rename, archive, and participant controls stay in Rooms.
            </Text>
            <View style={styles.linkRow}>
              <TouchableOpacity
                onPress={() =>
                  router.push({ pathname: '/buzz/channels', params: { communityId } } as Href)
                }
                style={styles.textButton}
              >
                <Text style={styles.textButtonLabel}>OPEN ROOMS</Text>
              </TouchableOpacity>
            </View>
            {rooms.map((room) => (
              <View key={room.id} style={styles.roomRow}>
                <TouchableOpacity
                  onPress={() => router.push(`/buzz/chat/${encodeURIComponent(room.id)}` as Href)}
                  style={styles.roomCopy}
                >
                  <Text numberOfLines={1} style={styles.roomName}># {room.name}</Text>
                  <Text style={styles.roomMeta}>
                    {room.canManage ? 'Tap visibility to change' : 'Room owner controls visibility'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
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
            ))}
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
  return ({
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
  title: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 18 },
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
    marginTop: 8,
    color: groknight.textPrimary,
    fontSize: 17,
  },
  sectionBody: {
    ...Typography.default(),
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
    minHeight: 48,
    marginTop: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 14,
  },
  primaryAction: { marginTop: 10 },
  textButton: { minHeight: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
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
    borderRadius: 3,
    backgroundColor: groknight.bgBase,
  },
  segmentSelected: { borderColor: groknight.selectedBorder, backgroundColor: groknight.bgHighlight },
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
    borderRadius: 3,
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
  memberName: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 13 },
  memberHandle: { ...Typography.mono(), marginTop: 2, color: groknight.textMuted, fontSize: 9 },
  roleRow: { marginTop: 7, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  roleButton: {
    minHeight: 30,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
  },
  roleButtonSelected: { borderColor: groknight.selectedBorder, backgroundColor: groknight.bgHighlight },
  roleText: { ...Typography.mono('semiBold'), color: groknight.textMuted, fontSize: 8 },
  roleTextSelected: { color: groknight.textPrimary },
  removeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { ...Typography.default(), color: groknight.steel, fontSize: 22 },
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
  inviteMeta: { ...Typography.default(), marginTop: 4, color: groknight.textMuted, fontSize: 10 },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  roomRow: {
    minHeight: 66,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  roomCopy: { flex: 1, minWidth: 0, minHeight: 56, justifyContent: 'center' },
  roomName: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 13 },
  roomMeta: { ...Typography.default(), marginTop: 3, color: groknight.textMuted, fontSize: 9 },
  visibilityButton: {
    minHeight: 36,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 3,
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
    marginTop: 14,
    color: groknight.textPrimary,
    fontSize: 18,
  },
  deniedBody: {
    ...Typography.default(),
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
    marginTop: 4,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  });
});
