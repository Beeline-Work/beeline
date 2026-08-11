import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Agent, Community, Identity } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { defaultSoul, requestGeneratedSoul } from '@/buzz/soul-generation';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { HullSurface, HullWaveSignal, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';

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
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<number | null>(null);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [intent, setIntent] = useState('');
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('');
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
        const fallback = defaultSoul(arrival.pubkey);
        setName(arrival.soulProfile?.name ?? fallback.name);
        setPersonality(arrival.soulProfile?.personality ?? fallback.personality);
      }
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
        const listed = await client.listAgents(activeWorkspaceId);
        if (cancelled) return;
        setIdentity(currentIdentity);
        setTransport(nextTransport);
        setCommunities(available);
        setCommunityId(activeWorkspaceId);
        setAgents(listed);
        interval = setInterval(() => {
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
  }, [refreshAgents, requestedCommunityId]);

  const handleAdd = useCallback(async () => {
    if (!transport || !communityId) return;
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
  }, [agents, communityId, transport]);

  const chooseAgent = useCallback((agent: Agent) => {
    setSelectedPubkey(agent.pubkey);
    const fallback = defaultSoul(agent.pubkey);
    setName(agent.soulProfile?.name ?? fallback.name);
    setPersonality(agent.soulProfile?.personality ?? fallback.personality);
    setIntent('');
    setError(null);
  }, []);

  const saveSoul = useCallback(
    async (nextName = name, nextPersonality = personality) => {
      if (!transport || !communityId || !selected) return;
      setWorking(true);
      setError(null);
      try {
        const client = await transport.ensureClient();
        await client.setAgentSoul(communityId, selected.pubkey, {
          name: nextName,
          personality: nextPersonality,
          avatarSeed: selected.pubkey,
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
    [communityId, name, personality, refreshAgents, selected, transport],
  );

  const handleGenerate = useCallback(async () => {
    if (!intent.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const generated = await requestGeneratedSoul(getBuzzRuntimeConfig().soulUrl, intent);
      setName(generated.name);
      setPersonality(generated.personality);
      await saveSoul(generated.name, generated.personality);
    } catch (caught) {
      setError(`Could not generate soul: ${String(caught)}`);
      setWorking(false);
    }
  }, [intent, saveSoul]);

  const handleSkip = useCallback(async () => {
    if (!selected) return;
    const fallback = defaultSoul(selected.pubkey);
    await saveSoul(fallback.name, fallback.personality);
  }, [saveSoul, selected]);

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
            <Text style={styles.title}>Agents</Text>
            {activeCommunity && <Text style={styles.headerMeta}>{activeCommunity.name}</Text>}
          </View>
          <TouchableOpacity
            accessibilityLabel="Add an agent"
            style={styles.addButton}
            disabled={working}
            onPress={() => void handleAdd()}
          >
            <Text style={styles.addButtonText}>＋</Text>
          </TouchableOpacity>
        </HullSurface>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {pairCommand && (
            <View style={styles.pairPanel}>
              <Text style={styles.pairNote}>Run this where your agent lives.</Text>
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

          {agents.length > 0 && (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Connected</Text>
              <Text style={styles.count}>{agents.length}</Text>
            </View>
          )}
          {agents.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyGlyph}>⌬</Text>
              <Text style={styles.emptyTitle}>No agents yet</Text>
              <Text style={styles.emptyCopy}>
                Connect once, then use the Agent in every {ROOM_LABEL}.
              </Text>
              {!pairCommand && (
                <MonoButton
                  label={working ? 'Connecting Agent' : 'Connect an Agent'}
                  loading={working}
                  style={styles.primaryButton}
                  disabled={working}
                  onPress={() => void handleAdd()}
                />
              )}
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
                  />
                  <View style={styles.agentCopy}>
                    <Text style={styles.agentName} numberOfLines={1}>
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

          {selected && (
            <View style={styles.editor}>
              <View style={styles.editorTitleRow}>
                <AgentAvatar
                  pubkey={selected.pubkey}
                  avatarSeed={resolveAgentDisplayIdentity(selected.pubkey, selected).avatarSeed}
                  avatarUrl={resolveAgentDisplayIdentity(selected.pubkey, selected).avatarUrl}
                  name={resolveAgentDisplayIdentity(selected.pubkey, selected).name}
                  size={42}
                />
                <View style={styles.editorTitleCopy}>
                  <Text style={styles.editorTitle}>
                    {selected.soulProfile ? 'Edit Agent' : 'Give this Agent a face'}
                  </Text>
                  <Text style={styles.editorHint}>Appearance never grants permissions.</Text>
                </View>
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
              <TouchableOpacity
                style={[styles.secondaryButton, (!intent.trim() || working) && styles.disabled]}
                disabled={!intent.trim() || working}
                onPress={() => void handleGenerate()}
              >
                <Text style={styles.secondaryButtonText}>
                  {working ? 'Generating…' : selected.soulProfile ? 'Regenerate' : 'Generate'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholderTextColor={groknight.dim}
                maxLength={80}
              />
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
                  disabled={!name.trim() || !personality.trim() || working}
                  onPress={() => void saveSoul()}
                />
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.flexButton]}
                  disabled={working}
                  onPress={() => void handleSkip()}
                >
                  <Text style={styles.secondaryButtonText}>Use default</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
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
  addButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonText: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 21,
    fontWeight: '500',
  },
  scrollContent: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 56 },
  pairPanel: {
    paddingBottom: 24,
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  pairNote: { ...Typography.default(), color: groknight.muted, fontSize: 13, lineHeight: 18 },
  commandRow: {
    marginTop: 14,
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
  sectionHeader: { marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  sectionTitle: {
    ...Typography.default('semiBold'),
    flex: 1,
    color: groknight.textPrimary,
    fontSize: 14,
  },
  count: { ...Typography.default(), color: groknight.muted, fontSize: 12 },
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
  disabled: { backgroundColor: groknight.bgBase },
});
