import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isSingleWordAgentName,
  type Agent,
  type Community,
  type CommunityMember,
  type CommunityRole,
  type Identity,
  type Nip05VerificationStatus,
  type PersonProfile,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { defaultAgentPersona } from '@/buzz/agent-persona';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { buildCommunityInviteUrl } from '@/buzz/community-invite';
import { personIdentityLabel, shortMemberNpub } from '@/buzz/member-display';
import { resolveNip05StatusMap } from '@/buzz/nip05-verification';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { HullSurface, HullWaveSignal, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';

const INSTALL_COMMAND = 'curl -fsSL https://relay.buzzrouter.com/install | sh';

function roleLabel(role: CommunityRole): string {
  return role.toUpperCase();
}

/** Owner and admin each carry a distinct accent; member stays neutral. */
function roleAccentColor(role: CommunityRole): string {
  if (role === 'owner') return groknight.accent;
  if (role === 'admin') return groknight.chrome;
  return groknight.textMuted;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function BuzzAgents() {
  const insets = useSafeAreaInsets();
  const requestedCommunityId = first(
    useLocalSearchParams<{ communityId?: string | string[] }>().communityId,
  );
  const [communityId, setCommunityId] = useState<string | null>(requestedCommunityId ?? null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [people, setPeople] = useState<CommunityMember[]>([]);
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [nip05Status, setNip05Status] = useState<Map<string, Nip05VerificationStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<number | null>(null);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [intent, setIntent] = useState('');
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [roleEditorPubkey, setRoleEditorPubkey] = useState<string | null>(null);
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | undefined>();
  const [canManageWorkspace, setCanManageWorkspace] = useState(false);
  const pairingBaseline = useRef<Set<string>>(new Set());
  const pairingPending = useRef(false);

  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === communityId) ?? null,
    [communities, communityId],
  );
  const selected = useMemo(
    () => agents.find((agent) => agent.pubkey === selectedPubkey) ?? null,
    [agents, selectedPubkey],
  );
  const profileByPubkey = useMemo(
    () => new Map(profiles.map((profile) => [profile.pubkey, profile])),
    [profiles],
  );

  useEffect(() => {
    let cancelled = false;
    resolveNip05StatusMap(profiles.map((profile) => ({ pubkey: profile.pubkey, nip05: profile.nip05 })))
      .then((map) => {
        if (!cancelled) setNip05Status(map);
      })
      .catch(() => {
        // A failed verification round leaves labels on their non-nip05 fallback; never fatal.
      });
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  const refreshAgents = useCallback(async (currentTransport: BuzzRigTransport, id: string) => {
    const client = await currentTransport.ensureClient();
    const next = await client.listAgents(id);
    setAgents(next);
    if (pairingPending.current) {
      const arrival = next.find((agent) => !pairingBaseline.current.has(agent.pubkey));
      if (arrival) {
        pairingPending.current = false;
        setPairCommand(null);
        setPairExpiresAt(null);
        setSelectedPubkey(arrival.pubkey);
        const fallback = defaultAgentPersona(arrival.pubkey);
        setName(arrival.soulProfile?.name ?? fallback.name);
        setPersonality(arrival.soulProfile?.personality ?? fallback.personality);
        setIntent(arrival.soulProfile?.intent ?? '');
        setAvatarUrl(arrival.soulProfile?.avatar ?? arrival.avatar);
      }
    }
  }, []);

  const refreshPeople = useCallback(async (
    currentTransport: BuzzRigTransport,
    id: string,
    viewerPubkey?: string,
  ) => {
    const client = await currentTransport.ensureClient();
    const [allMembers, knownAgents] = await Promise.all([
      client.communityMembers(id),
      client.listAgents(id),
    ]);
    const agentPubkeys = new Set(knownAgents.map((agent) => agent.pubkey));
    const nextPeople = allMembers.filter((member) => !agentPubkeys.has(member.pubkey));
    const nextProfiles = await client.listPersonProfiles(
      id,
      nextPeople.map((member) => member.pubkey),
    );
    setPeople(nextPeople);
    setProfiles(nextProfiles);
    if (viewerPubkey) {
      const viewerRole = allMembers.find((member) => member.pubkey === viewerPubkey)?.role;
      setCanManageWorkspace(viewerRole === 'owner' || viewerRole === 'admin');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const nextTransport = new BuzzRigTransport(currentIdentity, await getEffectiveRelayUrl());
        const client = await nextTransport.ensureClient();
        const { workspaces: available, activeWorkspaceId } = await prepareWorkspaceContext(
          client,
          currentIdentity.publicKey,
          requestedCommunityId,
        );
        const [listed, viewerProfile, allMembers] = await Promise.all([
          client.listAgents(activeWorkspaceId),
          client.getPersonProfile(activeWorkspaceId, currentIdentity.publicKey),
          client.communityMembers(activeWorkspaceId),
        ]);
        if (cancelled) return;
        setIdentity(currentIdentity);
        setTransport(nextTransport);
        setCommunities(available);
        setCommunityId(activeWorkspaceId);
        setAgents(listed);
        setViewerAvatarUrl(viewerProfile?.avatar);
        const role = allMembers.find((member) => member.pubkey === currentIdentity.publicKey)?.role;
        setCanManageWorkspace(role === 'owner' || role === 'admin');
        await refreshPeople(nextTransport, activeWorkspaceId, currentIdentity.publicKey);
        interval = setInterval(() => {
          if (!pairingPending.current) return;
          void refreshAgents(nextTransport, activeWorkspaceId).catch(() => undefined);
        }, 2000);
      } catch (caught) {
        if (!cancelled) setError(String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [refreshAgents, refreshPeople, requestedCommunityId]);

  const handleAdd = useCallback(async () => {
    if (!transport || !communityId || !canManageWorkspace) return;
    setWorking(true);
    setError(null);
    try {
      pairingBaseline.current = new Set(agents.map((agent) => agent.pubkey));
      pairingPending.current = true;
      const client = await transport.ensureClient();
      const pairing = await client.createAgentPairingCode(communityId);
      setPairCommand(`beeline pair ${pairing.code}`);
      setPairExpiresAt(pairing.expiresAt);
    } catch (caught) {
      pairingPending.current = false;
      setError(`Could not create pairing code: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [agents, canManageWorkspace, communityId, transport]);

  const invitePerson = useCallback(async () => {
    if (!transport || !communityId || !canManageWorkspace) return;
    setWorking(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const invite = await client.createInvite(communityId);
      const url = buildCommunityInviteUrl(invite.token, await getEffectiveRelayUrl());
      await Share.share({ message: url });
    } catch (caught) {
      setError(`Could not create person invite: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [canManageWorkspace, communityId, transport]);

  const setPersonRole = useCallback(
    async (pubkey: string, role: CommunityRole) => {
      if (!transport || !communityId || !canManageWorkspace) return;
      setWorking(true);
      setError(null);
      try {
        const client = await transport.ensureClient();
        await client.addMember(communityId, pubkey, role);
        await client.waitUntilMemberRole(communityId, pubkey, role);
        await refreshPeople(transport, communityId, identity?.publicKey);
      } catch (caught) {
        setError(`Could not change person role: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [canManageWorkspace, communityId, identity?.publicKey, refreshPeople, transport],
  );

  const removePerson = useCallback(
    async (pubkey: string) => {
      if (!transport || !communityId || !canManageWorkspace) return;
      setWorking(true);
      setError(null);
      try {
        const client = await transport.ensureClient();
        await client.removeMember(communityId, pubkey);
        await client.waitUntilNotMember(communityId, pubkey);
        await refreshPeople(transport, communityId, identity?.publicKey);
      } catch (caught) {
        setError(`Could not remove person: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [canManageWorkspace, communityId, identity?.publicKey, refreshPeople, transport],
  );

  const chooseAgent = useCallback((agent: Agent) => {
    setSelectedPubkey(agent.pubkey);
    const fallback = defaultAgentPersona(agent.pubkey);
    setName(agent.soulProfile?.name ?? fallback.name);
    setPersonality(agent.soulProfile?.personality ?? fallback.personality);
    setIntent(agent.soulProfile?.intent ?? '');
    setAvatarUrl(agent.soulProfile?.avatar ?? agent.avatar);
    setConfirmingRemoval(false);
    setError(null);
  }, []);

  const saveSoul = useCallback(
    async (nextName = name, nextPersonality = personality) => {
      if (!transport || !communityId || !selected || !canManageWorkspace) return;
      setWorking(true);
      setError(null);
      try {
        const client = await transport.ensureClient();
        await client.setAgentSoul(communityId, selected.pubkey, {
          name: nextName,
          personality: nextPersonality,
          intent,
          avatarSeed: selected.pubkey,
          ...(avatarUrl ? { avatar: avatarUrl } : {}),
        });
        setName(nextName);
        setPersonality(nextPersonality);
        await refreshAgents(transport, communityId);
      } catch (caught) {
        setError(`Could not save soul: ${String(caught)}`);
      } finally {
        setWorking(false);
      }
    },
    [avatarUrl, canManageWorkspace, communityId, intent, name, personality, refreshAgents, selected, transport],
  );

  const changeAvatar = useCallback(async () => {
    if (!transport || !communityId || !selected || !canManageWorkspace) return;
    setWorking(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const nextAvatar = await pickAndUploadAvatar(client);
      if (!nextAvatar) return;
      await client.setAgentSoul(communityId, selected.pubkey, {
        name,
        personality,
        intent,
        avatarSeed: selected.pubkey,
        avatar: nextAvatar,
      });
      setAvatarUrl(nextAvatar);
      await refreshAgents(transport, communityId);
    } catch (caught) {
      setError(`Could not set Agent picture: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [canManageWorkspace, communityId, intent, name, personality, refreshAgents, selected, transport]);

  const resetAvatar = useCallback(async () => {
    if (!transport || !communityId || !selected || !canManageWorkspace) return;
    setWorking(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      await client.setAgentSoul(communityId, selected.pubkey, {
        name,
        personality,
        intent,
        avatarSeed: selected.pubkey,
      });
      setAvatarUrl(undefined);
      await refreshAgents(transport, communityId);
    } catch (caught) {
      setError(`Could not restore generated Agent mark: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [canManageWorkspace, communityId, intent, name, personality, refreshAgents, selected, transport]);

  const handleUseDefault = useCallback(() => {
    if (!selected) return;
    const fallback = defaultAgentPersona(selected.pubkey);
    setName(fallback.name);
    setPersonality(fallback.personality);
  }, [selected]);

  const removeSelectedAgent = useCallback(async () => {
    if (!transport || !communityId || !selected || !canManageWorkspace) return;
    setWorking(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      await client.removeAgent(communityId, selected.pubkey);
      setSelectedPubkey(null);
      setIntent('');
      setName('');
      setPersonality('');
      setAvatarUrl(undefined);
      setConfirmingRemoval(false);
      await refreshAgents(transport, communityId);
    } catch (caught) {
      setError(`Could not remove Agent: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [canManageWorkspace, communityId, refreshAgents, selected, transport]);

  const messageSelectedAgent = useCallback(async () => {
    if (!transport || !communityId || !selected) return;
    setWorking(true);
    setError(null);
    try {
      const result = await transport.resolveDirectMessage(communityId, selected.pubkey);
      router.push(`/buzz/chat/${encodeURIComponent(result.channelId)}` as Href);
    } catch (caught) {
      setError(`Could not message Agent: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  }, [communityId, selected, transport]);

  if (loading) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top }]}>
        <PixelLoader />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={communityId ?? null}
      onSelect={(id) => {
        if (!id) return;
        router.replace({ pathname: '/buzz/channels', params: { communityId: id } });
      }}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings/identity' as Href)}
      onWorkspaceSettings={(id) =>
        router.push(
          { pathname: '/buzz/settings/workspace', params: { communityId: id } } as unknown as Href,
        )
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={viewerAvatarUrl}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
          <TouchableOpacity
            accessibilityLabel={`Back to ${ROOM_LABEL}s`}
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Members</Text>
            {activeCommunity && <Text style={styles.headerMeta}>{activeCommunity.name}</Text>}
          </View>
        </HullSurface>

        <KeyboardAwareScrollView
          bottomOffset={16}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {pairCommand && (
            <View style={styles.pairPanel}>
              <Text style={styles.pairNote}>Run this where your agent lives.</Text>
              <Text style={styles.stepLabel}>Install beeline (one-time):</Text>
              <TouchableOpacity
                accessibilityLabel="Copy install command"
                style={styles.commandRow}
                onPress={() => Clipboard.setStringAsync(INSTALL_COMMAND)}
              >
                <Text selectable style={styles.command}>
                  {INSTALL_COMMAND}
                </Text>
                <Text style={styles.copyText}>Copy</Text>
              </TouchableOpacity>
              <Text style={styles.stepLabel}>Then pair this Agent:</Text>
              <TouchableOpacity
                accessibilityLabel="Copy pairing command"
                style={styles.commandRow}
                onPress={() => Clipboard.setStringAsync(pairCommand)}
              >
                <Text selectable style={styles.command}>
                  {pairCommand}
                </Text>
                <Text style={styles.copyText}>Copy</Text>
              </TouchableOpacity>
              <View style={styles.waitingRow}>
                <HullWaveSignal compact label="WAITING" />
                <Text style={styles.expiry}>
                  Expires{' '}
                  {pairExpiresAt ? new Date(pairExpiresAt * 1000).toLocaleTimeString() : 'soon'}
                </Text>
              </View>
            </View>
          )}

          {error && (
            <View accessibilityRole="alert" style={styles.errorPanel}>
              <Text style={styles.errorLabel}>! ERROR</Text>
              <Text style={styles.error}>{error}</Text>
            </View>
          )}

          <View style={styles.memberSection} testID="members-people-section">
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>People</Text>
              <Text style={styles.count}>{people.length}</Text>
              {canManageWorkspace && (
                <MonoButton
                  label={working ? 'Creating invite' : 'Invite person'}
                  loading={working}
                  disabled={working}
                  onPress={() => void invitePerson()}
                  variant="secondary"
                  style={styles.sectionAction}
                  testID="invite-person"
                />
              )}
            </View>
            {people.length === 0 ? (
              <Text style={styles.sectionEmpty}>No people in this Workspace yet.</Text>
            ) : (
              <View style={styles.peopleList}>
                {people.map((person) => {
                  const profile = profileByPubkey.get(person.pubkey);
                  const immutableOwner = person.pubkey === activeCommunity?.ownerPubkey;
                  const isSelf = person.pubkey === identity?.publicKey;
                  const actorCanChange =
                    !immutableOwner &&
                    !isSelf &&
                    (canManageWorkspace &&
                      (activeCommunity?.viewerRole === 'owner' || person.role === 'member'));
                  return (
                    <View key={person.pubkey} style={styles.personRow}>
                      <PersonAvatar
                        avatarUrl={profile?.avatar}
                        name={profile?.name ?? shortMemberNpub(person.pubkey)}
                        pubkey={person.pubkey}
                        size={44}
                      />
                      <View style={styles.personCopy}>
                        <Text
                          numberOfLines={1}
                          style={styles.personName}
                          testID={`member-${person.pubkey}-identity`}
                        >
                          {personIdentityLabel(profile, person.pubkey, nip05Status.get(person.pubkey))}
                          {isSelf ? ' (you)' : ''}
                        </Text>
                      </View>
                      <View style={styles.personTrailing}>
                        {roleEditorPubkey === person.pubkey ? (
                          <View style={styles.roleSegment}>
                            {(['owner', 'admin', 'member'] as const).map((role, index) => {
                              const selectedRole = person.role === role;
                              const allowed =
                                actorCanChange &&
                                (activeCommunity?.viewerRole === 'owner' || role !== 'owner');
                              return (
                                <TouchableOpacity
                                  accessibilityState={{ selected: selectedRole, disabled: !allowed }}
                                  disabled={!allowed || selectedRole || working}
                                  key={role}
                                  onPress={() => {
                                    setRoleEditorPubkey(null);
                                    void setPersonRole(person.pubkey, role);
                                  }}
                                  style={[styles.roleSegmentButton, index > 0 && styles.roleSegmentDivider]}
                                  testID={`member-${person.pubkey}-${role}`}
                                >
                                  <Text
                                    style={[
                                      styles.roleText,
                                      selectedRole && styles.roleTextSelected,
                                    ]}
                                  >
                                    {roleLabel(role)}
                                  </Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        ) : (
                          <TouchableOpacity
                            accessibilityLabel={`${profile?.name ?? shortMemberNpub(person.pubkey)} role: ${roleLabel(person.role)}${actorCanChange ? '. Tap to change role.' : ''}`}
                            disabled={!actorCanChange}
                            onPress={() => setRoleEditorPubkey(person.pubkey)}
                            style={styles.roleLabelButton}
                            testID={`member-${person.pubkey}-role-label`}
                          >
                            <Text
                              style={[styles.roleLabelText, { color: roleAccentColor(person.role) }]}
                            >
                              {roleLabel(person.role)}
                            </Text>
                          </TouchableOpacity>
                        )}
                        {actorCanChange && (
                          <TouchableOpacity
                            accessibilityLabel={`Remove ${profile?.name ?? shortMemberNpub(person.pubkey)}`}
                            disabled={working}
                            onPress={() => void removePerson(person.pubkey)}
                            style={styles.removePersonButton}
                            testID={`member-${person.pubkey}-remove`}
                          >
                            <Text style={styles.removePersonText}>×</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          <View style={styles.memberSection} testID="members-agents-section">
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Agents</Text>
              <Text style={styles.count}>{agents.length}</Text>
              {canManageWorkspace && (
                <MonoButton
                  label={working ? 'Adding agent' : 'Add agent'}
                  loading={working}
                  disabled={working}
                  onPress={() => void handleAdd()}
                  variant="secondary"
                  style={styles.sectionAction}
                  testID="add-agent"
                />
              )}
            </View>
            {agents.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyGlyph}>⌬</Text>
              <Text style={styles.emptyTitle}>No agents yet</Text>
              <Text style={styles.emptyCopy}>
                Connect once, then use the Agent in every {ROOM_LABEL}.
              </Text>
            </View>
          ) : (
            agents.map((agent) => {
              const display = resolveAgentDisplayIdentity(agent.pubkey, agent);
              return (
                <TouchableOpacity
                  key={agent.agentId}
                  accessibilityLabel={`${display.name}, ${display.personality}`}
                  style={[
                    styles.agentRow,
                    selectedPubkey === agent.pubkey && styles.agentRowActive,
                  ]}
                  onPress={() => chooseAgent(agent)}
                >
                  <AgentAvatar
                    pubkey={agent.pubkey}
                    avatarSeed={display.avatarSeed}
                    avatarUrl={display.avatarUrl}
                    name={display.name}
                    size={44}
                  />
                  <View style={styles.agentCopy}>
                    <Text
                      style={styles.agentName}
                      numberOfLines={1}
                      testID={`agent-${agent.pubkey}-identity`}
                    >
                      {display.name}
                    </Text>
                    <Text style={styles.personality} numberOfLines={2}>
                      {display.personality}
                    </Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              );
            })
          )}
          </View>

          {selected && canManageWorkspace && (
            <View style={styles.editor}>
              <View style={styles.editorTitleRow}>
                <AgentAvatar
                  pubkey={selected.pubkey}
                  avatarSeed={resolveAgentDisplayIdentity(selected.pubkey, selected).avatarSeed}
                  avatarUrl={avatarUrl}
                  name={resolveAgentDisplayIdentity(selected.pubkey, selected).name}
                  size={42}
                />
                <View style={styles.editorTitleCopy}>
                  <Text style={styles.editorTitle}>
                    {selected.soulProfile ? 'Edit Agent' : 'Give this Agent a face'}
                  </Text>
                  <Text style={styles.editorHint}>
                    These instructions shape how the Agent works. They never grant permissions.
                  </Text>
                </View>
              </View>
              <View style={styles.avatarActions}>
                <TouchableOpacity
                  accessibilityLabel={`Message ${resolveAgentDisplayIdentity(selected.pubkey, selected).name}`}
                  style={styles.secondaryButton}
                  disabled={working}
                  onPress={() => void messageSelectedAgent()}
                  testID={`message-agent-${selected.pubkey}`}
                >
                  <Text style={styles.secondaryButtonText}>Message</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  disabled={working}
                  onPress={() => void changeAvatar()}
                >
                  <Text style={styles.secondaryButtonText}>
                    {avatarUrl ? 'Change picture' : 'Set picture'}
                  </Text>
                </TouchableOpacity>
                {avatarUrl && (
                  <TouchableOpacity
                    style={styles.avatarReset}
                    disabled={working}
                    onPress={() => void resetAvatar()}
                  >
                    <Text style={styles.avatarResetText}>Use generated mark</Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.label}>Intent</Text>
              <TextInput
                style={[styles.input, styles.intentInput]}
                value={intent}
                onChangeText={setIntent}
                placeholder="keep the test suite green and refactor mercilessly"
                placeholderTextColor={groknight.dim}
                multiline
                maxLength={500}
              />
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholderTextColor={groknight.dim}
                maxLength={32}
                autoCapitalize="words"
              />
              <Text style={styles.fieldHint}>
                One spoken word. Mention as @
                {name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'name'}.
              </Text>
              <Text style={styles.label}>Personality</Text>
              <TextInput
                style={[styles.input, styles.personalityInput]}
                value={personality}
                onChangeText={setPersonality}
                placeholderTextColor={groknight.dim}
                multiline
                maxLength={280}
              />
              <View style={styles.editorActions}>
                <MonoButton
                  label="Save"
                  style={[styles.primaryButton, styles.flexButton]}
                  disabled={
                    !intent.trim() || !isSingleWordAgentName(name) || !personality.trim() || working
                  }
                  onPress={() => void saveSoul()}
                />
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.flexButton]}
                  disabled={working}
                  onPress={handleUseDefault}
                >
                  <Text style={styles.secondaryButtonText}>Suggest locally</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                accessibilityLabel="Remove this Agent"
                accessibilityHint="Stops the Agent and ends its work on the host machine"
                style={styles.removeButton}
                disabled={working}
                onPress={() => setConfirmingRemoval(true)}
              >
                <Text style={styles.removeButtonLabel}>Remove Agent</Text>
                <Text style={styles.removeButtonHint}>Stops host sessions and disconnects</Text>
              </TouchableOpacity>
              {confirmingRemoval && (
                <View accessibilityRole="alert" style={styles.removeConfirm}>
                  <Text style={styles.removeConfirmFlag}>STOP AGENT</Text>
                  <Text style={styles.removeConfirmTitle}>
                    Remove {resolveAgentDisplayIdentity(selected.pubkey, selected).name}?
                  </Text>
                  <Text style={styles.removeConfirmCopy}>
                    This stops the Agent, ends its work and running sessions on the host, and
                    disconnects it from every Room in this Workspace.
                  </Text>
                  <View style={styles.removeConfirmActions}>
                    <TouchableOpacity
                      accessibilityLabel="Cancel Agent removal"
                      style={[styles.secondaryButton, styles.flexButton]}
                      disabled={working}
                      onPress={() => setConfirmingRemoval(false)}
                    >
                      <Text style={styles.secondaryButtonText}>Cancel</Text>
                    </TouchableOpacity>
                    <MonoButton
                      label={working ? 'Stopping Agent' : 'Stop & Remove'}
                      loading={working}
                      style={[styles.primaryButton, styles.flexButton]}
                      disabled={working}
                      onPress={() => void removeSelectedAgent()}
                    />
                  </View>
                </View>
              )}
            </View>
          )}
        </KeyboardAwareScrollView>
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.bgTerminal,
  },
  container: { flex: 1, minWidth: 0, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 58,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: groknight.bgBase,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.default(), color: groknight.chrome, fontSize: 30, fontWeight: '300' },
  headerCopy: { flex: 1, minWidth: 0, paddingLeft: 4 },
  title: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  headerMeta: { ...Typography.default(), marginTop: 2, color: groknight.muted, fontSize: 11 },
  scrollContent: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 56 },
  pairPanel: {
    paddingBottom: 24,
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  pairNote: { ...Typography.default(), color: groknight.muted, fontSize: 13, lineHeight: 18 },
  stepLabel: {
    ...Typography.default('semiBold'),
    marginTop: 14,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  commandRow: {
    marginTop: 6,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 13,
    backgroundColor: groknight.bgBase,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  command: {
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    ...Typography.mono('semiBold'),
    fontSize: 13,
  },
  copyText: {
    ...Typography.default('semiBold'),
    marginLeft: 10,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  waitingRow: { marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  expiry: { ...Typography.mono(), color: groknight.textMuted, fontSize: 11, lineHeight: 15 },
  errorPanel: {
    padding: 10,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  errorLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  error: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  memberSection: { marginBottom: 32 },
  sectionHeader: { marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionTitle: {
    ...Typography.default('semiBold'),
    flex: 1,
    color: groknight.textPrimary,
    fontSize: 14,
  },
  count: { ...Typography.default(), color: groknight.muted, fontSize: 12 },
  sectionAction: { alignSelf: 'center' },
  sectionEmpty: {
    ...Typography.default(),
    paddingVertical: 18,
    color: groknight.textMuted,
    fontSize: 13,
  },
  peopleList: {},
  personRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  personCopy: { flex: 1, minWidth: 0 },
  personName: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 15 },
  personTrailing: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  roleLabelButton: {
    minHeight: 28,
    minWidth: 44,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleLabelText: {
    ...Typography.mono('semiBold'),
    fontSize: 10,
    letterSpacing: 0.5,
  },
  roleSegment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  roleSegmentButton: {
    minHeight: 28,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleSegmentDivider: { borderLeftWidth: 1, borderLeftColor: groknight.border },
  roleText: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 8,
    letterSpacing: 0.4,
  },
  roleTextSelected: { color: groknight.textPrimary },
  removePersonButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removePersonText: { ...Typography.default(), color: groknight.steel, fontSize: 22 },
  empty: {
    alignItems: 'center',
    paddingTop: 46,
    paddingBottom: 34,
    paddingHorizontal: 22,
  },
  emptyGlyph: {
    ...Typography.default(),
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 12,
    color: groknight.steel,
    fontSize: 26,
    lineHeight: 42,
    textAlign: 'center',
  },
  emptyTitle: {
    ...Typography.default('semiBold'),
    marginTop: 10,
    color: groknight.textPrimary,
    fontSize: 16,
  },
  emptyCopy: {
    ...Typography.default(),
    marginTop: 7,
    color: groknight.steel,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  agentRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  agentRowActive: { backgroundColor: groknight.bgBase },
  agentCopy: { flex: 1, minWidth: 0 },
  agentName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 15,
  },
  personality: {
    ...Typography.default(),
    marginTop: 3,
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  chevron: { ...Typography.default(), color: groknight.chrome, fontSize: 24 },
  editor: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
  },
  editorTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  editorTitleCopy: { flex: 1, minWidth: 0 },
  avatarActions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  avatarReset: { minHeight: 44, justifyContent: 'center' },
  avatarResetText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
  },
  fieldHint: {
    ...Typography.mono(),
    marginTop: 6,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 15,
  },
  editorTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 16,
  },
  editorHint: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.steel,
    fontSize: 12,
    lineHeight: 17,
  },
  label: {
    ...Typography.default('semiBold'),
    marginTop: 10,
    marginBottom: 6,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    ...Typography.default(),
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: groknight.textPrimary,
    fontSize: 13,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  intentInput: { minHeight: 72, textAlignVertical: 'top' },
  personalityInput: { minHeight: 68, textAlignVertical: 'top' },
  primaryButton: {
    marginTop: 10,
  },
  secondaryButton: {
    marginTop: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: 'transparent',
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  editorActions: { flexDirection: 'row', gap: 8 },
  flexButton: { flex: 1, minWidth: 0 },
  removeButton: {
    marginTop: 22,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  removeButtonLabel: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  removeButtonHint: {
    ...Typography.default(),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  removeConfirm: {
    marginTop: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: groknight.textPrimary,
    backgroundColor: groknight.bgHighlight,
  },
  removeConfirmFlag: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 9,
    letterSpacing: 1.4,
  },
  removeConfirmTitle: {
    ...Typography.default('semiBold'),
    marginTop: 7,
    color: groknight.textPrimary,
    fontSize: 16,
  },
  removeConfirmCopy: {
    ...Typography.default(),
    marginTop: 6,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  removeConfirmActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  disabled: { backgroundColor: groknight.bgBase },
});
