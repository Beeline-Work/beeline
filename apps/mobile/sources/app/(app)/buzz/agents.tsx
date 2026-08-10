import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Agent, Community, Identity } from '@buzzy/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { defaultSoul, requestGeneratedSoul } from '@/buzz/soul-generation';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { BuzzRigTransport } from '@/sync/transport';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

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
      setPairCommand(`buzz pair ${pairing.code}`);
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
        <ActivityIndicator color={groknight.accent} />
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
        <View style={styles.header}>
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
        </View>

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
                <View style={styles.waitingDot} />
                <Text style={styles.expiry}>
                  Waiting for agent · expires{' '}
                  {pairExpiresAt ? new Date(pairExpiresAt * 1000).toLocaleTimeString() : 'soon'}
                </Text>
              </View>
            </View>
          )}

          {error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
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
                <TouchableOpacity
                  style={[styles.primaryButton, working && styles.disabled]}
                  disabled={working}
                  onPress={() => void handleAdd()}
                >
                  <Text style={styles.primaryButtonText}>
                    {working ? 'Connecting…' : 'Connect an Agent'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            agents.map((agent) => (
              <TouchableOpacity
                key={agent.agentId}
                style={[styles.agentRow, selectedPubkey === agent.pubkey && styles.agentRowActive]}
                onPress={() => chooseAgent(agent)}
              >
                <AgentAvatar pubkey={agent.pubkey} />
                <View style={styles.agentCopy}>
                  <Text style={styles.agentName} numberOfLines={1}>
                    {agent.displayName}
                  </Text>
                  <Text style={styles.personality} numberOfLines={1}>
                    {agent.personality ?? 'Ready for a soul.'}
                  </Text>
                  <Text style={styles.pubkey}>{agent.pubkey.slice(0, 12)}…</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            ))
          )}

          {selected && (
            <View style={styles.editor}>
              <View style={styles.editorTitleRow}>
                <AgentAvatar pubkey={selected.pubkey} size={42} />
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
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    (!name.trim() || !personality.trim() || working) && styles.disabled,
                    styles.flexButton,
                  ]}
                  disabled={!name.trim() || !personality.trim() || working}
                  onPress={() => void saveSoul()}
                >
                  <Text style={styles.primaryButtonText}>Save changes</Text>
                </TouchableOpacity>
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
  backButton: { width: 34, height: 42, alignItems: 'center', justifyContent: 'center' },
  backText: { color: groknight.chrome, fontSize: 30, fontWeight: '300' },
  headerCopy: { flex: 1, minWidth: 0, paddingLeft: 4 },
  title: { color: groknight.textPrimary, fontSize: 17, fontWeight: '700' },
  headerMeta: { marginTop: 2, color: groknight.muted, fontSize: 11 },
  addButton: {
    width: 38,
    height: 38,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonText: { color: groknight.steel, fontSize: 21, fontWeight: '500' },
  scrollContent: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 56 },
  pairPanel: {
    paddingBottom: 24,
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  pairNote: { color: groknight.muted, fontSize: 13, lineHeight: 18 },
  commandRow: {
    marginTop: 14,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 13,
    backgroundColor: groknight.bgBase,
    borderWidth: 1,
    borderColor: groknight.borderActive,
  },
  command: {
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '700',
  },
  copyText: {
    marginLeft: 10,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  waitingRow: { marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  waitingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: groknight.accent },
  expiry: { color: groknight.muted, fontSize: 11 },
  error: {
    padding: 10,
    color: groknight.textPrimary,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgHighlight,
    fontSize: 12,
  },
  sectionHeader: { marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  sectionTitle: {
    flex: 1,
    color: groknight.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  count: { color: groknight.muted, fontSize: 12 },
  empty: {
    alignItems: 'center',
    paddingTop: 46,
    paddingBottom: 34,
    paddingHorizontal: 22,
  },
  emptyGlyph: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 12,
    color: groknight.steel,
    fontSize: 26,
    lineHeight: 42,
    textAlign: 'center',
  },
  emptyTitle: { marginTop: 10, color: groknight.textPrimary, fontSize: 16, fontWeight: '800' },
  emptyCopy: {
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
  agentName: { color: groknight.textPrimary, fontSize: 15, fontWeight: '800' },
  personality: { marginTop: 3, color: groknight.textSecondary, fontSize: 11, lineHeight: 16 },
  pubkey: { marginTop: 4, color: groknight.steel, fontSize: 9 },
  chevron: { color: groknight.chrome, fontSize: 24 },
  editor: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
  },
  editorTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  editorTitleCopy: { flex: 1, minWidth: 0 },
  editorTitle: { color: groknight.textPrimary, fontSize: 16, fontWeight: '700' },
  editorHint: { marginTop: 4, color: groknight.steel, fontSize: 10, lineHeight: 14 },
  label: {
    marginTop: 10,
    marginBottom: 6,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: groknight.textPrimary,
    fontSize: 13,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgTerminal,
  },
  intentInput: { minHeight: 72, textAlignVertical: 'top' },
  personalityInput: { minHeight: 68, textAlignVertical: 'top' },
  primaryButton: {
    marginTop: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: groknight.accent,
  },
  primaryButtonText: {
    color: groknight.bgTerminal,
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryButton: {
    marginTop: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: 'transparent',
  },
  secondaryButtonText: {
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  editorActions: { flexDirection: 'row', gap: 8 },
  flexButton: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.42 },
});
