import React, { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
  decodeNpub,
  tagValue,
  tagValues,
  type BuzzClient,
  type Community,
  type CommunityInviteRecord,
  type CommunityMember,
  type CommunityRole,
  type Identity,
  type PersonProfile,
} from '@beeline/buzz-client';

import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { buildCommunityInviteUrl } from '@/buzz/community-invite';
import { groknight } from '@/buzz/groknight';
import { shortMemberNpub } from '@/buzz/member-display';
import { ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { HullSurface, MonoButton, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { WorkspaceAvatar } from '@/components/buzz/WorkspaceAvatar';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';

type WorkspaceRoomSetting = {
  id: string;
  name: string;
  visibility: 'public' | 'invite-only';
  canManage: boolean;
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeMemberPubkey(value: string): string | null {
  const candidate = value.trim();
  if (/^[0-9a-f]{64}$/i.test(candidate)) return candidate.toLowerCase();
  if (!candidate.toLowerCase().startsWith('npub1')) return null;
  try {
    return decodeNpub(candidate.toLowerCase());
  } catch {
    return null;
  }
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
        canManage: role === 'owner' || role === 'admin',
      } satisfies WorkspaceRoomSetting;
    }),
  );
  return rooms.sort((a, b) => a.name.localeCompare(b.name));
}

function roleLabel(role: CommunityRole): string {
  return role.toUpperCase();
}

export default function WorkspaceSettings() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const communityId = firstParam(params.communityId);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [client, setClient] = useState<BuzzClient | null>(null);
  const [relayUrl, setRelayUrl] = useState('');
  const [community, setCommunity] = useState<Community | null>(null);
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [invites, setInvites] = useState<CommunityInviteRecord[]>([]);
  const [rooms, setRooms] = useState<WorkspaceRoomSetting[]>([]);
  const [workspaceName, setWorkspaceName] = useState('');
  const [newMember, setNewMember] = useState('');
  const [readyInviteUrls, setReadyInviteUrls] = useState<Record<string, string>>({});
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const actorRole = useMemo(
    () => members.find((member) => member.pubkey === identity?.publicKey)?.role ?? null,
    [identity?.publicKey, members],
  );
  const canManageWorkspace = actorRole === 'owner' || actorRole === 'admin';
  const profileByPubkey = useMemo(
    () => new Map(profiles.map((profile) => [profile.pubkey, profile])),
    [profiles],
  );

  const reloadMembers = useCallback(
    async (activeClient: BuzzClient, activeCommunityId: string) => {
      const [allMembers, agents] = await Promise.all([
        activeClient.communityMembers(activeCommunityId),
        activeClient.listAgents(activeCommunityId),
      ]);
      const agentPubkeys = new Set(agents.map((agent) => agent.pubkey));
      const nextMembers = allMembers.filter((member) => !agentPubkeys.has(member.pubkey));
      const nextProfiles = await activeClient.listPersonProfiles(
        activeCommunityId,
        nextMembers.map((member) => member.pubkey),
      );
      setMembers(nextMembers);
      setProfiles(nextProfiles);
    },
    [],
  );

  const reloadInvites = useCallback(
    async (activeClient: BuzzClient, activeCommunityId: string) => {
      setInvites(await activeClient.listCommunityInvites(activeCommunityId));
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      setIdentity(null);
      setClient(null);
      setCommunity(null);
      setMembers([]);
      setProfiles([]);
      setInvites([]);
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
          const [nextCommunity, allMembers, agents] = await Promise.all([
            currentClient.getCommunity(communityId),
            currentClient.communityMembers(communityId),
            currentClient.listAgents(communityId),
          ]);
          if (!nextCommunity) throw new Error('Workspace not found.');
          const nextActorRole = allMembers.find(
            (member) => member.pubkey === currentIdentity.publicKey,
          )?.role;
          const agentPubkeys = new Set(agents.map((agent) => agent.pubkey));
          const nextMembers = allMembers.filter((member) => !agentPubkeys.has(member.pubkey));
          if (cancelled) return;
          setIdentity(currentIdentity);
          setClient(currentClient);
          setRelayUrl(currentRelayUrl);
          setCommunity(nextCommunity);
          setWorkspaceName(nextCommunity.name);
          setMembers(nextMembers);
          if (nextActorRole !== 'owner' && nextActorRole !== 'admin') return;

          const [nextProfiles, nextInvites, nextRooms] = await Promise.all([
            currentClient.listPersonProfiles(
              communityId,
              nextMembers.map((member) => member.pubkey),
            ),
            currentClient.listCommunityInvites(communityId),
            loadWorkspaceRooms(currentClient, communityId, currentIdentity.publicKey),
          ]);
          if (!cancelled) {
            setProfiles(nextProfiles);
            setInvites(nextInvites);
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
      setCommunity(updated);
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
      setCommunity(await client.setCommunityAvatar(communityId, avatar));
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
      setCommunity(await client.setCommunityAvatar(communityId, ''));
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
        setCommunity(await client.setCommunityVisibility(communityId, visibility));
      } catch (caught) {
        setError(`Could not change ${WORKSPACE_LABEL} visibility: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client, community?.visibility, communityId],
  );

  const addWorkspaceMember = useCallback(async () => {
    if (!client || !communityId) return;
    const pubkey = normalizeMemberPubkey(newMember);
    if (!pubkey) {
      setError('Enter a valid npub or 64-character public key.');
      return;
    }
    setWorkingKey(`member-${pubkey}`);
    setError(null);
    try {
      if (await client.isAgentIdentity(pubkey)) {
        throw new Error('Use Manage Agents for agent identities.');
      }
      await client.addMember(communityId, pubkey, 'member');
      await client.waitUntilMember(communityId, pubkey);
      setNewMember('');
      await reloadMembers(client, communityId);
    } catch (caught) {
      setError(`Could not add member: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId, newMember, reloadMembers]);

  const setWorkspaceMemberRole = useCallback(
    async (pubkey: string, role: CommunityRole) => {
      if (!client || !communityId) return;
      setWorkingKey(`member-${pubkey}`);
      setError(null);
      try {
        await client.addMember(communityId, pubkey, role);
        await client.waitUntilMemberRole(communityId, pubkey, role);
        await reloadMembers(client, communityId);
      } catch (caught) {
        setError(`Could not change member role: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client, communityId, reloadMembers],
  );

  const removeWorkspaceMember = useCallback(
    async (pubkey: string) => {
      if (!client || !communityId) return;
      setWorkingKey(`member-${pubkey}`);
      setError(null);
      try {
        await client.removeMember(communityId, pubkey);
        await client.waitUntilNotMember(communityId, pubkey);
        await reloadMembers(client, communityId);
      } catch (caught) {
        setError(`Could not remove member: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client, communityId, reloadMembers],
  );

  const createWorkspaceInvite = useCallback(async () => {
    if (!client || !communityId || !relayUrl) return;
    setWorkingKey('invite-new');
    setError(null);
    try {
      const invite = await client.createInvite(communityId);
      const url = buildCommunityInviteUrl(invite.token, relayUrl);
      setReadyInviteUrls((current) => ({ ...current, [invite.tokenHash]: url }));
      await reloadInvites(client, communityId);
      await Share.share({ message: url });
    } catch (caught) {
      setError(`Could not create invite: ${String(caught)}`);
    } finally {
      setWorkingKey(null);
    }
  }, [client, communityId, relayUrl, reloadInvites]);

  const revokeWorkspaceInvite = useCallback(
    async (tokenHash: string) => {
      if (!client || !communityId) return;
      setWorkingKey(`invite-${tokenHash}`);
      setError(null);
      try {
        await client.revokeCommunityInvite(communityId, tokenHash);
        setReadyInviteUrls((current) => {
          const next = { ...current };
          delete next[tokenHash];
          return next;
        });
        await reloadInvites(client, communityId);
      } catch (caught) {
        setError(`Could not revoke invite: ${String(caught)}`);
      } finally {
        setWorkingKey(null);
      }
    },
    [client, communityId, reloadInvites],
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
              <WorkspaceAvatar community={community} size={72} />
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
              placeholderTextColor={groknight.dim}
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

          <View style={styles.section} testID="workspace-members-settings">
            <Text style={styles.sectionLabel}>MEMBERS & ROLES</Text>
            <View style={styles.addMemberRow}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setNewMember}
                onSubmitEditing={() => void addWorkspaceMember()}
                placeholder="npub1… or public key"
                placeholderTextColor={groknight.dim}
                style={[styles.input, styles.memberInput]}
                value={newMember}
              />
              <TouchableOpacity
                disabled={!newMember.trim() || workingKey?.startsWith('member-')}
                onPress={() => void addWorkspaceMember()}
                style={styles.compactAction}
                testID="workspace-member-add"
              >
                <Text style={styles.compactActionText}>ADD</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.memberList}>
              {members.map((member) => {
                const profile = profileByPubkey.get(member.pubkey);
                const immutableOwner = member.pubkey === community?.ownerPubkey;
                const isSelf = member.pubkey === identity?.publicKey;
                const actorCanChange =
                  !immutableOwner &&
                  !isSelf &&
                  (actorRole === 'owner' || (actorRole === 'admin' && member.role === 'member'));
                return (
                  <View key={member.pubkey} style={styles.memberRow}>
                    <PersonAvatar
                      avatarUrl={profile?.avatar}
                      name={profile?.name ?? shortMemberNpub(member.pubkey)}
                      pubkey={member.pubkey}
                      size={38}
                    />
                    <View style={styles.memberCopy}>
                      <Text numberOfLines={1} style={styles.memberName}>
                        {profile?.name ?? shortMemberNpub(member.pubkey)}
                        {isSelf ? ' (you)' : ''}
                      </Text>
                      <Text numberOfLines={1} style={styles.memberHandle}>
                        {profile?.handle ? `@${profile.handle}` : shortMemberNpub(member.pubkey)}
                      </Text>
                      <View style={styles.roleRow}>
                        {(['owner', 'admin', 'member'] as const).map((role) => {
                          const selected = member.role === role;
                          const allowed = actorCanChange && (actorRole === 'owner' || role !== 'owner');
                          return (
                            <TouchableOpacity
                              accessibilityState={{ selected, disabled: !allowed }}
                              disabled={!allowed || selected || workingKey === `member-${member.pubkey}`}
                              key={role}
                              onPress={() => void setWorkspaceMemberRole(member.pubkey, role)}
                              style={[styles.roleButton, selected && styles.roleButtonSelected]}
                              testID={`workspace-member-${member.pubkey}-${role}`}
                            >
                              <Text style={[styles.roleText, selected && styles.roleTextSelected]}>
                                {roleLabel(role)}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                    {actorCanChange && (
                      <TouchableOpacity
                        accessibilityLabel={`Remove ${profile?.name ?? shortMemberNpub(member.pubkey)}`}
                        disabled={workingKey === `member-${member.pubkey}`}
                        onPress={() => void removeWorkspaceMember(member.pubkey)}
                        style={styles.removeButton}
                        testID={`workspace-member-${member.pubkey}-remove`}
                      >
                        <Text style={styles.removeText}>×</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>
          </View>

          <View style={styles.section} testID="workspace-invites-settings">
            <Text style={styles.sectionLabel}>INVITES</Text>
            <Text style={styles.sectionBody}>
              Links are one-purpose credentials. Revoke a link when it should stop working.
            </Text>
            <MonoButton
              label="Create invite link"
              loading={workingKey === 'invite-new'}
              onPress={() => void createWorkspaceInvite()}
              style={styles.primaryAction}
            />
            {invites.map((invite) => (
              <View key={invite.tokenHash} style={styles.inviteRow}>
                <View style={styles.settingCopy}>
                  <Text style={styles.inviteTitle}>INVITE · {invite.tokenHash.slice(0, 10)}</Text>
                  <Text style={styles.inviteMeta}>
                    Expires {new Date(invite.expiresAt * 1000).toLocaleDateString()}
                  </Text>
                </View>
                {readyInviteUrls[invite.tokenHash] && (
                  <TouchableOpacity
                    onPress={() => void Share.share({ message: readyInviteUrls[invite.tokenHash]! })}
                    style={styles.textButton}
                  >
                    <Text style={styles.textButtonLabel}>SHARE</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  disabled={workingKey === `invite-${invite.tokenHash}`}
                  onPress={() => void revokeWorkspaceInvite(invite.tokenHash)}
                  style={styles.textButton}
                  testID={`workspace-invite-${invite.tokenHash}-revoke`}
                >
                  <Text style={styles.textButtonLabel}>REVOKE</Text>
                </TouchableOpacity>
              </View>
            ))}
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
              <TouchableOpacity
                onPress={() =>
                  router.push({ pathname: '/buzz/agents', params: { communityId } } as Href)
                }
                style={styles.textButton}
              >
                <Text style={styles.textButtonLabel}>MANAGE AGENTS</Text>
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

const styles = StyleSheet.create({
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
    borderRadius: 4,
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
    borderRadius: 4,
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
    borderRadius: 4,
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
