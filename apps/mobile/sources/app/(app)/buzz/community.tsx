import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community, Identity } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { createCommunityInviteUrl, parseCommunityInviteToken } from '@/buzz/community-invite';
import { loadActiveCommunityId, saveActiveCommunityId } from '@/buzz/community-storage';
import { groknight } from '@/buzz/groknight';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { HullSurface, MonoButton, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';

export default function BuzzCommunityCreateOrJoin() {
  const insets = useSafeAreaInsets();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(null);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [communityName, setCommunityName] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const relayUrl = await getEffectiveRelayUrl();
        const nextTransport = new BuzzRigTransport(currentIdentity, relayUrl);
        const client = await nextTransport.ensureClient();
        const available = await client.listCommunities();
        const stored = await loadActiveCommunityId(currentIdentity.publicKey);
        if (cancelled) return;
        setIdentity(currentIdentity);
        setTransport(nextTransport);
        setRelayUrl(relayUrl);
        setCommunities(available);
        setActiveCommunityId(
          available.some((community) => community.communityId === stored) ? stored : null,
        );
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = useCallback(async () => {
    const name = communityName.trim();
    if (!name || !transport || !identity || !relayUrl) return;
    setWorking(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const communityId = await client.createCommunity(name);
      await client.waitUntilMember(communityId, identity.publicKey);
      const inviteUrl = await createCommunityInviteUrl(client, communityId, relayUrl);
      await saveActiveCommunityId(identity.publicKey, communityId);
      router.replace({
        pathname: '/buzz/channels',
        params: { communityId, inviteUrl },
      });
    } catch (err) {
      setError(`Could not create ${WORKSPACE_LABEL}: ${String(err)}`);
    } finally {
      setWorking(false);
    }
  }, [communityName, identity, relayUrl, transport]);

  const handleJoin = useCallback(() => {
    const token = parseCommunityInviteToken(inviteInput);
    if (!token) {
      setError('Paste a valid Workspace invite link.');
      return;
    }
    router.push(`/join/${encodeURIComponent(token)}` as Href);
  }, [inviteInput]);

  const selectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  if (!identity && !error) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top }]}>
        <PixelLoader />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={selectCommunity}
      onAdd={() => undefined}
      onSettings={() => router.push('/buzz/settings' as Href)}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="Back"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>{WORKSPACE_LABEL}s</Text>
          </View>
        </HullSurface>

        <View style={styles.modeSwitch}>
          <TouchableOpacity
            style={[styles.modeButton, mode === 'create' && styles.modeButtonActive]}
            onPress={() => {
              setMode('create');
              setError(null);
            }}
          >
            <Text style={[styles.modeText, mode === 'create' && styles.modeTextActive]}>
              Create
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, mode === 'join' && styles.modeButtonActive]}
            onPress={() => {
              setMode('join');
              setError(null);
            }}
          >
            <Text style={[styles.modeText, mode === 'join' && styles.modeTextActive]}>Join</Text>
          </TouchableOpacity>
        </View>

        <PixelGateReveal style={styles.form}>
          {mode === 'create' ? (
            <>
              <Text style={styles.formTitle}>Name the new {WORKSPACE_LABEL}</Text>
              <Text style={styles.formHint}>
                A private invite is ready as soon as you create it.
              </Text>
              <TextInput
                autoFocus
                style={styles.input}
                value={communityName}
                onChangeText={setCommunityName}
                onSubmitEditing={() => void handleCreate()}
                editable={!working}
                maxLength={80}
                placeholder="Night shift"
                placeholderTextColor={groknight.dim}
              />
              <MonoButton
                label={working ? `Creating ${WORKSPACE_LABEL}` : `Create ${WORKSPACE_LABEL}`}
                loading={working}
                style={styles.primaryButton}
                disabled={!communityName.trim() || working}
                onPress={() => void handleCreate()}
              />
            </>
          ) : (
            <>
              <Text style={styles.formTitle}>Open an invite</Text>
              <Text style={styles.formHint}>
                Paste an invite to preview the {WORKSPACE_LABEL} before joining.
              </Text>
              <TextInput
                autoFocus
                style={[styles.input, styles.inviteInput]}
                value={inviteInput}
                onChangeText={setInviteInput}
                onSubmitEditing={handleJoin}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://relay.buzzrouter.com/join/…"
                placeholderTextColor={groknight.dim}
              />
              <MonoButton
                label="Preview invite"
                style={styles.primaryButton}
                disabled={!inviteInput.trim()}
                onPress={handleJoin}
              />
            </>
          )}

          {error && (
            <View accessibilityRole="alert" style={styles.errorPanel}>
              <Text style={styles.errorLabel}>! ERROR</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </PixelGateReveal>
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
    paddingHorizontal: 12,
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
  modeSwitch: {
    marginHorizontal: 16,
    marginTop: 22,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  modeButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    borderBottomWidth: 2,
    borderBottomColor: groknight.textSecondary,
  },
  modeText: {
    ...Typography.default('semiBold'),
    color: groknight.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  modeTextActive: { color: groknight.textPrimary },
  form: { paddingHorizontal: 18, paddingTop: 32 },
  formTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
  },
  formHint: {
    ...Typography.default(),
    marginTop: 8,
    maxWidth: 460,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    ...Typography.default(),
    minHeight: 48,
    marginTop: 22,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.border,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 14,
  },
  inviteInput: { ...Typography.mono(), fontSize: 11 },
  primaryButton: {
    marginTop: 12,
  },
  errorPanel: {
    marginTop: 14,
    padding: 12,
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
  errorText: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
