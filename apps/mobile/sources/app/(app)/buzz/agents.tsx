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
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { BuzzRigTransport } from '@/sync/transport';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function BuzzAgents() {
  const insets = useSafeAreaInsets();
  const communityId = first(
    useLocalSearchParams<{ communityId?: string | string[] }>().communityId,
  );
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

  const refreshAgents = useCallback(
    async (currentTransport: BuzzRigTransport, id: string) => {
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
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        if (!communityId) throw new Error('Choose a community before managing agents.');
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const nextTransport = new BuzzRigTransport(currentIdentity, await getEffectiveRelayUrl());
        const client = await nextTransport.ensureClient();
        const [available, listed] = await Promise.all([
          client.listCommunities(),
          client.listAgents(communityId),
        ]);
        if (cancelled) return;
        setIdentity(currentIdentity);
        setTransport(nextTransport);
        setCommunities(available);
        setAgents(listed);
        interval = setInterval(() => {
          void refreshAgents(nextTransport, communityId).catch(() => undefined);
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
  }, [communityId, refreshAgents]);

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
      onSelect={(id) =>
        router.replace({ pathname: '/buzz/channels', params: { communityId: id ?? 'standalone' } })
      }
      onAdd={() => router.push('/buzz/community' as Href)}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="Back to channels"
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>community crew</Text>
            <Text style={styles.title}>{activeCommunity?.name ?? 'Agents'}</Text>
          </View>
          <TouchableOpacity
            accessibilityLabel="Add an agent"
            style={styles.addButton}
            disabled={working}
            onPress={() => void handleAdd()}
          >
            <Text style={styles.addButtonText}>＋ agent</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {pairCommand && (
            <View style={styles.pairPanel}>
              <Text style={styles.panelEyebrow}>pair on the agent machine</Text>
              <Text style={styles.pairNote}>
                Run this where the agent lives — your laptop or headless box. No QR required.
              </Text>
              <TouchableOpacity
                accessibilityLabel="Copy pairing command"
                style={styles.commandRow}
                onPress={() => Clipboard.setStringAsync(pairCommand)}
              >
                <Text selectable style={styles.command}>
                  {pairCommand}
                </Text>
                <Text style={styles.copyText}>copy</Text>
              </TouchableOpacity>
              <Text style={styles.expiry}>
                expires{' '}
                {pairExpiresAt ? new Date(pairExpiresAt * 1000).toLocaleTimeString() : 'soon'} ·
                waiting for agent…
              </Text>
            </View>
          )}

          {error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>available agents</Text>
            <Text style={styles.count}>{agents.length}</Text>
          </View>
          {agents.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyGlyph}>⌬</Text>
              <Text style={styles.emptyTitle}>No agents paired</Text>
              <Text style={styles.emptyCopy}>
                Pair a machine once. Its agent becomes available across every channel in this
                community.
              </Text>
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
                  <Text style={styles.panelEyebrow}>
                    {selected.soulProfile ? 'edit soul' : 'give this agent a soul'}
                  </Text>
                  <Text style={styles.editorHint}>
                    Display-only character. It grants no permissions.
                  </Text>
                </View>
              </View>
              <Text style={styles.label}>intent</Text>
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
                style={[styles.primaryButton, (!intent.trim() || working) && styles.disabled]}
                disabled={!intent.trim() || working}
                onPress={() => void handleGenerate()}
              >
                <Text style={styles.primaryButtonText}>
                  {working ? 'generating…' : selected.soulProfile ? 'regenerate' : 'generate soul'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.label}>name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholderTextColor={groknight.dim}
                maxLength={80}
              />
              <Text style={styles.label}>personality</Text>
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
                  <Text style={styles.primaryButtonText}>save changes</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.flexButton]}
                  disabled={working}
                  onPress={() => void handleSkip()}
                >
                  <Text style={styles.secondaryButtonText}>use default</Text>
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
    minHeight: 70,
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
  eyebrow: {
    color: groknight.steel,
    fontFamily: mono,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  title: { marginTop: 3, color: groknight.textPrimary, fontSize: 18, fontWeight: '800' },
  addButton: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: groknight.accent,
    backgroundColor: groknight.bgCode,
  },
  addButtonText: { color: groknight.accent, fontFamily: mono, fontSize: 11, fontWeight: '800' },
  scrollContent: { padding: 16, paddingBottom: 56, gap: 10 },
  pairPanel: {
    padding: 14,
    borderWidth: 1,
    borderColor: groknight.accent,
    backgroundColor: groknight.bgCode,
  },
  panelEyebrow: {
    color: groknight.accent,
    fontFamily: mono,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  pairNote: { marginTop: 8, color: groknight.textSecondary, fontSize: 12, lineHeight: 18 },
  commandRow: {
    marginTop: 12,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: groknight.bgTerminal,
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
    color: groknight.accent,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '800',
  },
  expiry: { marginTop: 8, color: groknight.steel, fontFamily: mono, fontSize: 9 },
  error: {
    padding: 10,
    color: groknight.textPrimary,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgHighlight,
    fontSize: 12,
  },
  sectionHeader: { marginTop: 8, flexDirection: 'row', alignItems: 'center' },
  sectionTitle: {
    flex: 1,
    color: groknight.chrome,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  count: { color: groknight.accent, fontFamily: mono, fontSize: 11 },
  empty: {
    alignItems: 'center',
    paddingVertical: 34,
    paddingHorizontal: 22,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  emptyGlyph: { color: groknight.accent, fontSize: 34 },
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
    padding: 12,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  agentRowActive: { borderColor: groknight.accent, backgroundColor: groknight.bgCode },
  agentCopy: { flex: 1, minWidth: 0 },
  agentName: { color: groknight.textPrimary, fontSize: 15, fontWeight: '800' },
  personality: { marginTop: 3, color: groknight.textSecondary, fontSize: 11, lineHeight: 16 },
  pubkey: { marginTop: 4, color: groknight.steel, fontFamily: mono, fontSize: 9 },
  chevron: { color: groknight.chrome, fontSize: 24 },
  editor: {
    marginTop: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgBase,
  },
  editorTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  editorTitleCopy: { flex: 1, minWidth: 0 },
  editorHint: { marginTop: 4, color: groknight.steel, fontSize: 10, lineHeight: 14 },
  label: {
    marginTop: 10,
    marginBottom: 6,
    color: groknight.chrome,
    fontFamily: mono,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: groknight.textPrimary,
    fontFamily: mono,
    fontSize: 12,
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
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '900',
  },
  secondaryButton: {
    marginTop: 10,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgCode,
  },
  secondaryButtonText: {
    color: groknight.chrome,
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '800',
  },
  editorActions: { flexDirection: 'row', gap: 8 },
  flexButton: { flex: 1, minWidth: 0 },
  disabled: { opacity: 0.42 },
});
