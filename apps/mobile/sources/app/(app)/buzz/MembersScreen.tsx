import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Share, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AGENT_NAME_MAX_LENGTH,
  RoomViewClient,
  SurfaceRefreshScheduler,
  isAgentDetailView,
  isAllowedAgentModelConfigCategory,
  isReasonableAgentName,
  isWorkspaceView,
  type AgentDetailView,
  type AgentModelConfigInput,
  type AgentModelConfigOption,
  type Identity,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { createCommunityInviteUrl } from '@/buzz/community-invite';
import { defaultAgentPersona } from '@/buzz/agent-persona';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { HullSurface, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import { MEMBERS_GLYPH, MEMBERS_LABEL } from '@/buzz/vocabulary';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { filterAgentModelOptions } from '@/buzz/agent-model-picker';
import { Modal } from '@/modal/ModalManager';

const MODEL_FALLBACK_AXES: AgentModelConfigOption[] = [
  { id: 'model', category: 'model', options: [] },
  { id: 'effort', category: 'effort', options: [] },
];
const EFFORT_FALLBACK_LEVELS = ['low', 'medium', 'high'];
const INDEX_CONFIRM_ATTEMPTS = 60;
const INDEX_CONFIRM_DELAY_MS = 250;
const INSTALL_AND_PAIR_PREFIX = 'curl -fsSL https://usebeeline.app/install | sh && beeline pair';

async function copyText(value: string): Promise<void> {
  await (await import('expo-clipboard')).setStringAsync(value);
}

type WorkspaceRole = 'owner' | 'admin' | 'member';
type MembersAction =
  | 'invite-person'
  | 'pair-agent'
  | 'person-role'
  | 'save-agent-soul'
  | 'remove-agent'
  | 'model-config';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIndexedSurface<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  let latest: T | undefined;
  for (let attempt = 0; attempt < INDEX_CONFIRM_ATTEMPTS; attempt += 1) {
    latest = await read();
    if (accepts(latest)) return latest;
    if (attempt + 1 < INDEX_CONFIRM_ATTEMPTS) await delay(INDEX_CONFIRM_DELAY_MS);
  }
  throw new Error('The change was published, but the indexed Workspace view did not confirm it.');
}

function canChangeRole(
  viewerRole: WorkspaceRole,
  viewerPubkey: string,
  targetPubkey: string,
  targetRole: WorkspaceRole,
): boolean {
  if (viewerPubkey === targetPubkey) return false;
  if (viewerRole === 'owner') return true;
  return viewerRole === 'admin' && targetRole !== 'owner';
}

function canAssignRole(viewerRole: WorkspaceRole, role: WorkspaceRole): boolean {
  return viewerRole === 'owner' || (viewerRole === 'admin' && role !== 'owner');
}

function axisValue(detail: AgentDetailView, axis: AgentModelConfigOption): string | undefined {
  if (axis.category === 'model') {
    return detail.selected?.model ?? detail.runtimeSelection?.model ?? axis.currentValue;
  }
  return detail.selected?.effort ?? detail.runtimeSelection?.effort ?? axis.currentValue;
}

export default function BuzzMembers() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    action?: string | string[];
  }>();
  const workspaceId = first(params.communityId);
  const requestedAction = first(params.action);
  const [surface, setSurface] = useState<WorkspaceView | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentDetailView | null>(null);
  const [editingAgentSoul, setEditingAgentSoul] = useState(false);
  const [agentNameDraft, setAgentNameDraft] = useState('');
  const [agentSoulDraft, setAgentSoulDraft] = useState('');
  const [roleEditorPubkey, setRoleEditorPubkey] = useState<string | null>(null);
  const [openModelAxis, setOpenModelAxis] = useState<string | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [working, setWorking] = useState<MembersAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [agentInviteOpen, setAgentInviteOpen] = useState(false);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<number | null>(null);
  const schedulerRef = useRef<SurfaceRefreshScheduler<WorkspaceView> | null>(null);
  const agentRequestGenerationRef = useRef(0);
  const requestedActionHandledRef = useRef(false);

  const workspaceAddress = (nextIdentity = identity, nextRelayUrl = relayUrl) =>
    nextIdentity && nextRelayUrl && workspaceId
      ? surfaceAddress(nextRelayUrl, nextIdentity.publicKey, '/workspace/:id', { workspaceId })
      : null;

  const readWorkspace = async (): Promise<WorkspaceView> => {
    if (!identity || !relayUrl || !workspaceId) throw new Error('Workspace connection unavailable');
    const value = await new RoomViewClient({ baseUrl: relayUrl, identity }).workspace(workspaceId);
    setSurface(value);
    const address = workspaceAddress();
    if (address) await mobileSurfaceCache.write(address, value, isWorkspaceView);
    return value;
  };

  const readAgent = async (agentPubkey: string): Promise<AgentDetailView> => {
    if (!identity || !relayUrl || !workspaceId) throw new Error('Workspace connection unavailable');
    const value = await new RoomViewClient({ baseUrl: relayUrl, identity }).agent(
      workspaceId,
      agentPubkey,
    );
    setSelectedAgent(value);
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
      workspaceId,
      agentPubkey,
    });
    await mobileSurfaceCache.write(address, value, isAgentDetailView);
    return value;
  };

  const writeClient = async () => {
    if (!identity || !relayUrl) throw new Error('Workspace connection unavailable');
    return new BuzzRigTransport(identity, relayUrl).ensureClient();
  };

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let scheduler: SurfaceRefreshScheduler<WorkspaceView> | undefined;
    void (async () => {
      const nextIdentity = await loadBuzzIdentity();
      if (!nextIdentity) {
        router.replace('/buzz/onboarding');
        return;
      }
      const nextRelayUrl = await getEffectiveRelayUrl();
      const address = surfaceAddress(nextRelayUrl, nextIdentity.publicKey, '/workspace/:id', {
        workspaceId,
      });
      const cached = await mobileSurfaceCache.read(address, isWorkspaceView);
      if (cancelled) return;
      setIdentity(nextIdentity);
      setRelayUrl(nextRelayUrl);
      if (cached) setSurface(cached);
      const http = new RoomViewClient({ baseUrl: nextRelayUrl, identity: nextIdentity });
      scheduler = new SurfaceRefreshScheduler({
        fetch: () => http.workspace(workspaceId),
        apply: (value) => {
          setSurface(value);
          setError(null);
          void mobileSurfaceCache.write(address, value, isWorkspaceView);
        },
        onError: (reason) => setError(String(reason)),
      });
      schedulerRef.current = scheduler;
      const relay = await new BuzzRigTransport(nextIdentity, nextRelayUrl).ensureClient();
      unsubscribe = await relay.surfaceSubscribe(
        cached?.watchFilters ?? [{ kinds: [0, 9, 9000, 9001], '#h': [workspaceId] }],
        () => scheduler?.signal(),
      );
      if (cancelled) return unsubscribe();
      await scheduler.startAfter(Promise.resolve());
    })().catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => {
      cancelled = true;
      agentRequestGenerationRef.current += 1;
      unsubscribe?.();
      scheduler?.dispose();
      schedulerRef.current = null;
    };
  }, [retryGeneration, workspaceId]);

  const openAgent = async (agentPubkey: string) => {
    if (!identity || !relayUrl || !workspaceId) return;
    const generation = ++agentRequestGenerationRef.current;
    setRoleEditorPubkey(null);
    setOpenModelAxis(null);
    setEditingAgentSoul(false);
    setError(null);
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
      workspaceId,
      agentPubkey,
    });
    try {
      const cached = await mobileSurfaceCache.read(address, isAgentDetailView);
      if (generation !== agentRequestGenerationRef.current) return;
      if (cached) setSelectedAgent(cached);
      const value = await new RoomViewClient({ baseUrl: relayUrl, identity }).agent(
        workspaceId,
        agentPubkey,
      );
      if (generation !== agentRequestGenerationRef.current) return;
      setSelectedAgent(value);
      await mobileSurfaceCache.write(address, value, isAgentDetailView);
    } catch (reason) {
      if (generation === agentRequestGenerationRef.current) setError(String(reason));
    }
  };

  const invitePerson = async () => {
    if (!surface?.viewer.permissions.manage || !workspaceId || !relayUrl) return;
    setWorking('invite-person');
    setError(null);
    try {
      const url = await createCommunityInviteUrl(await writeClient(), workspaceId, relayUrl);
      await Share.share({ message: url });
    } catch (reason) {
      setError(`Could not create person invite: ${String(reason)}`);
    } finally {
      setWorking(null);
    }
  };

  /**
   * The new agent gets attached to every top-level Room the inviting user
   * belongs to as a side effect of pairing redemption (see
   * `attachAgentToInviterRooms` in `@beeline/buzz-client`), so this sheet
   * only ever needs to show the one pairing command — never a Room picker.
   */
  const openAgentInvite = async () => {
    if (!surface?.viewer.permissions.manage || !workspaceId) return;
    setAgentInviteOpen(true);
    setSelectedAgent(null);
    setPairCommand(null);
    setWorking('pair-agent');
    setError(null);
    try {
      const pairing = await (await writeClient()).createAgentPairingCode(workspaceId);
      setPairCommand(`${INSTALL_AND_PAIR_PREFIX} ${pairing.code}`);
      setPairExpiresAt(pairing.expiresAt);
    } catch (reason) {
      setError(`Could not create agent pairing code: ${String(reason)}`);
    } finally {
      setWorking(null);
    }
  };

  useEffect(() => {
    if (!surface?.viewer.permissions.manage || requestedActionHandledRef.current) return;
    if (requestedAction === 'invite') {
      requestedActionHandledRef.current = true;
      void invitePerson();
    } else if (requestedAction === 'add-agent') {
      requestedActionHandledRef.current = true;
      void openAgentInvite();
    }
    // The route intent is consume-once. The handlers intentionally read the
    // current authenticated surface at that moment rather than reopening on
    // every indexed refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedAction, surface]);

  const setPersonRole = async (pubkey: string, role: WorkspaceRole) => {
    if (!surface || !workspaceId) return;
    const target = surface.members.find((member) => member.identity.pubkey === pubkey);
    if (
      !target ||
      !surface.viewer.permissions.manage ||
      !canChangeRole(surface.viewer.role, surface.viewer.identity.pubkey, pubkey, target.role) ||
      !canAssignRole(surface.viewer.role, role)
    )
      return;
    setWorking('person-role');
    setError(null);
    try {
      const client = await writeClient();
      await client.addMember(workspaceId, pubkey, role);
      await client.waitUntilMemberRole(workspaceId, pubkey, role);
      await waitForIndexedSurface(readWorkspace, (value) =>
        value.members.some((member) => member.identity.pubkey === pubkey && member.role === role),
      );
      setRoleEditorPubkey(null);
    } catch (reason) {
      setError(`Could not change person role: ${String(reason)}`);
    } finally {
      setWorking(null);
    }
  };

  const beginAgentSoulEdit = () => {
    if (!selectedAgent) return;
    const fallback = defaultAgentPersona(selectedAgent.agent.identity.pubkey);
    setAgentNameDraft(selectedAgent.soul?.name ?? selectedAgent.agent.identity.name);
    setAgentSoulDraft(selectedAgent.soul?.instructions ?? fallback.soul);
    setEditingAgentSoul(true);
  };

  const saveAgentSoul = async () => {
    if (!selectedAgent || !surface?.viewer.permissions.manage || !workspaceId) return;
    const name = agentNameDraft.trim().slice(0, AGENT_NAME_MAX_LENGTH);
    const soul = agentSoulDraft.trim();
    if (!isReasonableAgentName(name)) {
      setError('Agent name must be a short spoken name.');
      return;
    }
    if (!soul) {
      setError('Agent soul instructions cannot be empty.');
      return;
    }
    setWorking('save-agent-soul');
    setError(null);
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const fallback = defaultAgentPersona(pubkey);
      const client = await writeClient();
      await client.setAgentSoul(workspaceId, pubkey, {
        name,
        soul,
        avatarSeed: selectedAgent.soul?.avatarSeed ?? pubkey,
        ...(selectedAgent.soul?.avatar ? { avatar: selectedAgent.soul.avatar } : {}),
      });
      await Promise.all([
        waitForIndexedSurface(
          () => readAgent(pubkey),
          (value) => value.agent.identity.name === name && value.soul?.name === name,
        ),
        waitForIndexedSurface(readWorkspace, (value) =>
          value.agents.some(
            (member) => member.identity.pubkey === pubkey && member.identity.name === name,
          ),
        ),
      ]);
      setEditingAgentSoul(false);
    } catch (reason) {
      setError(`Could not save agent settings: ${String(reason)}`);
    } finally {
      setWorking(null);
    }
  };

  const setModelOption = async (axis: AgentModelConfigOption, choiceId: string) => {
    if (!selectedAgent || !surface?.viewer.permissions.manage) return;
    if (!isAllowedAgentModelConfigCategory(axis.category)) return;
    const input: AgentModelConfigInput =
      axis.category === 'model' ? { model: choiceId } : { effort: choiceId };
    setWorking('model-config');
    setError(null);
    try {
      const pubkey = selectedAgent.agent.identity.pubkey;
      const client = await writeClient();
      await client.setAgentModelConfig(selectedAgent.workspaceId, pubkey, input);
      await waitForIndexedSurface(
        () => readAgent(pubkey),
        (value) =>
          axis.category === 'model'
            ? value.selected?.model === choiceId
            : value.selected?.effort === choiceId,
      );
      setOpenModelAxis(null);
      setModelSearchQuery('');
    } catch (reason) {
      setError(
        `Could not set ${axis.category === 'model' ? 'model' : 'effort'}: ${String(reason)}`,
      );
    } finally {
      setWorking(null);
    }
  };

  const setCustomModel = async (axis: AgentModelConfigOption) => {
    const model = await Modal.prompt('Set model', 'Enter the model ID accepted by this agent.', {
      placeholder: 'provider/model-id',
      cancelText: 'Cancel',
      confirmText: 'Set model',
    });
    if (!model?.trim()) return;
    await setModelOption(axis, model.trim());
  };

  const removeSelectedAgent = async () => {
    if (!selectedAgent || !surface?.viewer.permissions.manage || !workspaceId) return;
    const pubkey = selectedAgent.agent.identity.pubkey;
    const name = selectedAgent.agent.identity.name;
    const confirmed = await Modal.confirm(
      `Remove ${name}?`,
      'This removes the agent from every Room and the Workspace. The paired host then confirms that removal, drains active sessions, stops the daemon, and deletes its runtime configuration. Re-pairing is required to restore it.',
      { cancelText: 'Cancel', confirmText: 'Remove agent', destructive: true },
    );
    if (!confirmed) return;
    setWorking('remove-agent');
    setError(null);
    try {
      const client = await writeClient();
      await client.removeAgent(workspaceId, pubkey);
      await waitForIndexedSurface(
        readWorkspace,
        (value) => !value.agents.some((member) => member.identity.pubkey === pubkey),
      );
      agentRequestGenerationRef.current += 1;
      setSelectedAgent(null);
      setOpenModelAxis(null);
      setModelSearchQuery('');
    } catch (reason) {
      setError(`Could not remove agent: ${String(reason)}`);
    } finally {
      setWorking(null);
    }
  };

  const modelAxes = useMemo(() => {
    const advertised =
      selectedAgent?.catalog.filter((axis) => isAllowedAgentModelConfigCategory(axis.category)) ??
      [];
    return advertised.length > 0 ? advertised : MODEL_FALLBACK_AXES;
  }, [selectedAgent]);
  const hasAdvertisedModelCatalog = Boolean(
    selectedAgent?.catalog.some(
      (axis) => axis.category === 'model' && axis.options.length > 0,
    ),
  );

  if (!surface && !error) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loadingText}>LOADING {MEMBERS_LABEL.toUpperCase()}</Text>
      </View>
    );
  }
  if (!surface) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{error}</Text>
        <MonoButton label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
      </View>
    );
  }

  const busy = working !== null;
  const canManage = surface.viewer.permissions.manage;

  return (
    <BuzzCommunityShell
      communities={[workspaceRailItem(surface.workspace)]}
      activeCommunityId={surface.workspace.id}
      onSelect={(communityId) =>
        communityId &&
        router.replace({ pathname: '/buzz/channels', params: { communityId } } as never)
      }
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({ pathname: '/buzz/settings/workspace', params: { communityId } } as never)
      }
      canManageActiveCommunity={canManage}
      viewerPubkey={surface.viewer.identity.pubkey}
      viewerAvatarUrl={surface.viewer.identity.avatar}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{surface.workspace.name}</Text>
            <Text style={styles.title}>
              {MEMBERS_GLYPH} {MEMBERS_LABEL}
            </Text>
          </View>
          <Text style={styles.count}>{surface.members.length + surface.agents.length}</Text>
        </View>
        {!!error && (
          <TouchableOpacity onPress={() => schedulerRef.current?.force()} style={styles.errorPanel}>
            <Text style={styles.error}>! {error}</Text>
          </TouchableOpacity>
        )}
        <KeyboardAwareScrollView
          bottomOffset={16}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {canManage && (
            <View style={styles.memberActions} testID="members-invite-actions">
              <MonoButton
                label={working === 'invite-person' ? 'CREATING INVITE' : 'INVITE PERSON'}
                loading={working === 'invite-person'}
                disabled={busy}
                onPress={() => void invitePerson()}
                variant="secondary"
                labelStyle={styles.actionLabel}
                testID="invite-person"
              />
              <MonoButton
                label={working === 'pair-agent' ? 'CREATING CODE' : 'INVITE AGENT'}
                loading={working === 'pair-agent'}
                disabled={busy}
                onPress={() => void openAgentInvite()}
                variant="secondary"
                labelStyle={styles.actionLabel}
                testID="invite-agent"
              />
            </View>
          )}
          {agentInviteOpen && (
            <HullSurface strength="raised" style={styles.invitePanel} testID="invite-agent-flow">
              <View style={styles.inviteHeading}>
                <View style={styles.rowCopy}>
                  <Text style={styles.sectionLabel}>INVITE AGENT</Text>
                  <Text style={styles.detail}>
                    Run this where the new agent will live. It joins every Room you're in.
                  </Text>
                </View>
                <MonoButton
                  label="CLOSE"
                  variant="secondary"
                  labelStyle={styles.actionLabel}
                  onPress={() => {
                    setAgentInviteOpen(false);
                    setPairCommand(null);
                  }}
                />
              </View>
              {pairCommand ? (
                <View style={styles.commandList}>
                  <TouchableOpacity
                    accessibilityLabel="Copy install and pair command"
                    onPress={() => void copyText(pairCommand)}
                    style={styles.commandRow}
                  >
                    <Text selectable style={styles.command} testID="pair-agent-command">
                      {pairCommand}
                    </Text>
                    <Text style={styles.copy}>COPY</Text>
                  </TouchableOpacity>
                  <Text style={styles.expiry}>
                    EXPIRES{' '}
                    {pairExpiresAt ? new Date(pairExpiresAt * 1000).toLocaleTimeString() : 'SOON'}
                  </Text>
                </View>
              ) : (
                working === 'pair-agent' && <PixelLoader />
              )}
            </HullSurface>
          )}
          <View style={styles.section} testID="members-people-section">
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionLabel}>PEOPLE</Text>
              <Text style={styles.count} testID="members-people-count">
                {surface.members.length}
              </Text>
            </View>
            {surface.members.map((member) => {
              const editable = canChangeRole(
                surface.viewer.role,
                surface.viewer.identity.pubkey,
                member.identity.pubkey,
                member.role,
              );
              const editorOpen = roleEditorPubkey === member.identity.pubkey;
              return (
                <View key={member.identity.pubkey}>
                  <TouchableOpacity
                    disabled={!editable || busy}
                    onPress={() => setRoleEditorPubkey(editorOpen ? null : member.identity.pubkey)}
                    style={styles.row}
                    testID={`member-${member.identity.pubkey}-identity`}
                  >
                    <IdentityMark
                      kind="human"
                      seed={member.identity.pubkey}
                      avatarUrl={member.identity.avatar}
                      name={member.identity.name}
                      size={38}
                    />
                    <View style={styles.rowCopy}>
                      <Text style={styles.name}>{member.identity.name}</Text>
                      <Text style={styles.detail}>
                        {member.identity.handle ?? member.identity.pubkey.slice(0, 12)} ·{' '}
                        {member.role.toUpperCase()}
                      </Text>
                    </View>
                    {editable && <Text style={styles.chevron}>{editorOpen ? '⌄' : '›'}</Text>}
                  </TouchableOpacity>
                  {editorOpen && (
                    <View
                      style={styles.rolePicker}
                      testID={`member-${member.identity.pubkey}-roles`}
                    >
                      {(['member', 'admin', 'owner'] as const).map((role) => {
                        const allowed = canAssignRole(surface.viewer.role, role);
                        return (
                          <TouchableOpacity
                            key={role}
                            disabled={!allowed || member.role === role || busy}
                            onPress={() => void setPersonRole(member.identity.pubkey, role)}
                            style={[
                              styles.choice,
                              styles.roleChoice,
                              member.role === role && styles.choiceActive,
                              !allowed && styles.choiceDisabled,
                            ]}
                            testID={`member-${member.identity.pubkey}-${role}`}
                          >
                            <Text style={styles.choiceText}>{role.toUpperCase()}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
          <View style={styles.section} testID="members-agents-section">
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionLabel}>AGENTS</Text>
              <Text style={styles.count}>{surface.agents.length}</Text>
            </View>
            {surface.agents.map((member) => (
              <TouchableOpacity
                key={member.identity.pubkey}
                style={styles.row}
                onPress={() => void openAgent(member.identity.pubkey)}
                testID={`agent-${member.identity.pubkey}-identity`}
              >
                <IdentityMark
                  kind="agent"
                  seed={member.identity.pubkey}
                  avatarUrl={member.identity.avatar}
                  name={member.identity.name}
                  size={38}
                  alive={member.presence?.status === 'online'}
                />
                <View style={styles.rowCopy}>
                  <Text style={styles.name}>{member.identity.name}</Text>
                  <Text style={styles.detail}>
                    {member.presence?.status.toUpperCase() ?? 'OFFLINE'} ·{' '}
                    {member.role.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
          {selectedAgent && (
            <HullSurface
              strength="raised"
              style={styles.detailPanel}
              testID={`agent-${selectedAgent.agent.identity.pubkey}-model-config`}
            >
              <View style={styles.detailHeading}>
                <View style={styles.rowCopy}>
                  <Text style={styles.sectionLabel}>AGENT SETTINGS</Text>
                  <View style={styles.agentTitleRow}>
                    <Text style={styles.name}>{selectedAgent.agent.identity.name}</Text>
                    {canManage && (
                      <TouchableOpacity
                        accessibilityLabel="Edit agent settings"
                        disabled={busy}
                        onPress={beginAgentSoulEdit}
                        style={styles.glyphControl}
                        testID="edit-agent-soul"
                      >
                        <Text style={styles.glyphControlText}>✎</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
                <TouchableOpacity
                  accessibilityLabel="Close agent settings"
                  onPress={() => {
                    agentRequestGenerationRef.current += 1;
                    setSelectedAgent(null);
                    setEditingAgentSoul(false);
                  }}
                  style={styles.glyphControl}
                  testID="close-agent-settings"
                >
                  <Text style={styles.glyphControlText}>×</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.soulSection}>
                <Text style={styles.sectionLabel}>SOUL</Text>
                {editingAgentSoul ? (
                  <>
                    <Text style={styles.fieldLabel}>NAME</Text>
                    <TextInput
                      autoCapitalize="words"
                      editable={!busy}
                      maxLength={AGENT_NAME_MAX_LENGTH}
                      onChangeText={setAgentNameDraft}
                      placeholder="Agent name"
                      style={styles.textInput}
                      testID="agent-soul-name"
                      value={agentNameDraft}
                    />
                    <Text style={styles.fieldLabel}>PERSONA / INSTRUCTIONS</Text>
                    <TextInput
                      editable={!busy}
                      maxLength={1000}
                      multiline
                      onChangeText={setAgentSoulDraft}
                      placeholder="How this agent should work"
                      style={[styles.textInput, styles.soulInput]}
                      testID="agent-soul-instructions"
                      value={agentSoulDraft}
                    />
                    <View style={styles.soulActions}>
                      <MonoButton
                        label="CANCEL"
                        disabled={busy}
                        onPress={() => setEditingAgentSoul(false)}
                        variant="secondary"
                      />
                      <MonoButton
                        label={working === 'save-agent-soul' ? 'SAVING' : 'SAVE'}
                        loading={working === 'save-agent-soul'}
                        disabled={busy}
                        onPress={() => void saveAgentSoul()}
                        testID="save-agent-soul"
                      />
                    </View>
                  </>
                ) : (
                  <Text style={styles.soulCopy} testID="agent-soul-copy">
                    {selectedAgent.soul?.instructions ??
                      defaultAgentPersona(selectedAgent.agent.identity.pubkey).soul}
                  </Text>
                )}
              </View>
              <View style={styles.modelSection}>
                <Text style={styles.sectionLabel}>MODEL / EFFORT</Text>
                {!hasAdvertisedModelCatalog && (
                  <Text style={styles.detail} testID="model-catalog-missing">
                    This agent has not reported a model catalog yet. Model remains configurable;
                    effort uses safe fixed levels until the live catalog arrives.
                  </Text>
                )}
                {modelAxes.map((axis) => {
                  const isEffort = axis.category !== 'model';
                  const choices: Array<{ id: string; name?: string }> =
                    axis.options.length > 0
                      ? axis.options
                      : isEffort
                        ? EFFORT_FALLBACK_LEVELS.map((id) => ({ id }))
                        : [];
                  const current = axisValue(selectedAgent, axis);
                  const open = openModelAxis === axis.id;
                  const visibleChoices =
                    isEffort ? choices : filterAgentModelOptions(choices, modelSearchQuery);
                  return (
                    <View key={axis.id} style={styles.axisBlock}>
                      <TouchableOpacity
                        disabled={!canManage || busy}
                        onPress={() => {
                          setOpenModelAxis(open ? null : axis.id);
                          setModelSearchQuery('');
                        }}
                        style={styles.axisRow}
                        testID={`model-axis-${axis.id}`}
                      >
                        <Text style={styles.axisLabel}>{isEffort ? 'EFFORT' : 'MODEL'}</Text>
                        <Text style={styles.axisValue} numberOfLines={1}>
                          {current ?? 'Not set — tap to choose'}
                        </Text>
                        {canManage && <Text style={styles.chevron}>{open ? '⌄' : '›'}</Text>}
                      </TouchableOpacity>
                      {open && !isEffort && (
                        <TextInput
                          autoCapitalize="none"
                          autoCorrect={false}
                          editable={!busy}
                          onChangeText={setModelSearchQuery}
                          placeholder="Search models"
                          style={styles.modelSearchInput}
                          testID={`model-search-${axis.id}`}
                          value={modelSearchQuery}
                        />
                      )}
                      {open &&
                        visibleChoices.map((choice) => (
                          <TouchableOpacity
                            key={choice.id}
                            disabled={busy}
                            onPress={() => void setModelOption(axis, choice.id)}
                            style={[styles.choice, choice.id === current && styles.choiceActive]}
                            testID={`model-option-${axis.id}-${choice.id}`}
                          >
                            <Text style={styles.choiceText}>{choice.name ?? choice.id}</Text>
                            {choice.id === current && <Text style={styles.choiceText}>✓</Text>}
                          </TouchableOpacity>
                        ))}
                      {open && !isEffort && !hasAdvertisedModelCatalog && (
                        <TouchableOpacity
                          disabled={busy}
                          onPress={() => void setCustomModel(axis)}
                          style={styles.choice}
                          testID={`model-custom-${axis.id}`}
                        >
                          <Text style={styles.choiceText}>SET MODEL ID…</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
              {canManage && (
                <View style={styles.dangerZone}>
                  <Text style={styles.dangerCopy}>
                    Removal tears down the paired host after Workspace absence is confirmed.
                  </Text>
                  <MonoButton
                    label={working === 'remove-agent' ? 'REMOVING AGENT' : 'REMOVE AGENT'}
                    loading={working === 'remove-agent'}
                    disabled={busy}
                    onPress={() => void removeSelectedAgent()}
                    variant="destructive"
                    testID="remove-agent"
                  />
                </View>
              )}
            </HullSurface>
          )}
        </KeyboardAwareScrollView>
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28 },
    loadingText: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 10,
      letterSpacing: 1,
    },
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { ...Typography.default(), color: hull.textPrimary, fontSize: 30 },
    headerCopy: { flex: 1 },
    eyebrow: { ...Typography.default(), color: hull.textMuted, fontSize: 9 },
    title: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 18 },
    count: { ...Typography.mono('semiBold'), color: hull.chrome, fontSize: 11 },
    errorPanel: { padding: 9 },
    error: { ...Typography.default(), color: hull.danger, fontSize: 11, textAlign: 'center' },
    content: { padding: 14, gap: 16, paddingBottom: 40 },
    memberActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    actionLabel: { ...Typography.mono('semiBold'), fontSize: 10, letterSpacing: 0.7 },
    section: {},
    sectionHeading: {
      minHeight: 30,
      gap: 10,
      flexDirection: 'row',
      alignItems: 'center',
    },
    sectionLabel: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 9,
      letterSpacing: 0.8,
    },
    row: {
      minHeight: 62,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0 },
    name: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 14 },
    detail: { ...Typography.default(), color: hull.textMuted, fontSize: 11, marginTop: 3 },
    chevron: { ...Typography.default(), color: hull.textMuted, fontSize: 22 },
    rolePicker: { flexDirection: 'row', padding: 8, gap: 6, backgroundColor: hull.bgRaised },
    choice: {
      minHeight: 38,
      minWidth: 0,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
    },
    modelSearchInput: {
      minHeight: 38,
      paddingHorizontal: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      color: hull.textPrimary,
      ...Typography.default(),
      fontSize: 11,
    },
    roleChoice: { flex: 1 },
    choiceActive: { borderColor: hull.chrome, backgroundColor: hull.bgPressed },
    choiceDisabled: { opacity: 0.35 },
    choiceText: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 9 },
    invitePanel: { padding: 12, gap: 12 },
    inviteHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    commandList: { gap: 7 },
    commandRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: 3,
    },
    command: { ...Typography.mono(), color: hull.textPrimary, fontSize: 10, flex: 1 },
    copy: { ...Typography.mono('semiBold'), color: hull.chrome, fontSize: 9 },
    expiry: { ...Typography.mono(), color: hull.textMuted, fontSize: 9 },
    detailPanel: { padding: 14, gap: 12 },
    detailHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    agentTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    glyphControl: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    glyphControlText: { ...Typography.default(), color: hull.textMuted, fontSize: 22 },
    soulSection: { gap: 7 },
    soulCopy: { ...Typography.default(), color: hull.textPrimary, fontSize: 11, lineHeight: 17 },
    fieldLabel: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 8,
      letterSpacing: 0.7,
    },
    textInput: {
      ...Typography.default(),
      color: hull.textPrimary,
      minHeight: 40,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      backgroundColor: hull.bgTerminal,
    },
    soulInput: { minHeight: 112, textAlignVertical: 'top' },
    soulActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    modelSection: { gap: 8 },
    axisBlock: { borderWidth: StyleSheet.hairlineWidth, borderColor: hull.border },
    axisRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 10,
    },
    axisLabel: { ...Typography.default('semiBold'), color: hull.textMuted, fontSize: 9, width: 54 },
    axisValue: {
      ...Typography.default('semiBold'),
      color: hull.textPrimary,
      fontSize: 11,
      flex: 1,
      minWidth: 0,
    },
    dangerZone: {
      gap: 8,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.danger,
    },
    dangerCopy: { ...Typography.default(), color: hull.danger, fontSize: 10 },
  };
});
