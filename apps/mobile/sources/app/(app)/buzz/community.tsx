import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community, Identity } from '@buzzy/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { buildCommunityInviteUrl, parseCommunityInviteToken } from '@/buzz/community-invite';
import { loadActiveCommunityId, saveActiveCommunityId } from '@/buzz/community-storage';
import { groknight } from '@/buzz/groknight';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

export default function BuzzCommunityCreateOrJoin() {
  const insets = useSafeAreaInsets();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
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
    if (!name || !transport || !identity) return;
    setWorking(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const communityId = await client.createCommunity(name);
      await client.waitUntilMember(communityId, identity.publicKey);
      const invite = await client.createInvite(communityId);
      const inviteUrl = buildCommunityInviteUrl(invite.token);
      await saveActiveCommunityId(identity.publicKey, communityId);
      router.replace({
        pathname: '/buzz/channels',
        params: { communityId, inviteUrl },
      });
    } catch (err) {
      setError(`Could not create community: ${String(err)}`);
    } finally {
      setWorking(false);
    }
  }, [communityName, identity, transport]);

  const handleJoin = useCallback(() => {
    const token = parseCommunityInviteToken(inviteInput);
    if (!token) {
      setError('Paste a valid buzzrouter.com/join invite link.');
      return;
    }
    router.push(`/join/${encodeURIComponent(token)}` as Href);
  }, [inviteInput]);

  const selectCommunity = useCallback((communityId: string | null) => {
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId: communityId ?? 'standalone' },
    });
  }, []);

  if (!identity && !error) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top }]}>
        <ActivityIndicator color={groknight.accent} />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={selectCommunity}
      onAdd={() => undefined}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="Back"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>community dock</Text>
            <Text style={styles.title}>Create or join</Text>
          </View>
        </View>

        <View style={styles.modeSwitch}>
          <TouchableOpacity
            style={[styles.modeButton, mode === 'create' && styles.modeButtonActive]}
            onPress={() => {
              setMode('create');
              setError(null);
            }}
          >
            <Text style={[styles.modeText, mode === 'create' && styles.modeTextActive]}>
              create
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeButton, mode === 'join' && styles.modeButtonActive]}
            onPress={() => {
              setMode('join');
              setError(null);
            }}
          >
            <Text style={[styles.modeText, mode === 'join' && styles.modeTextActive]}>join</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          {mode === 'create' ? (
            <>
              <Text style={styles.formTitle}>Name the new community</Text>
              <Text style={styles.formHint}>
                You become its owner. A private invite link is minted once, ready to share.
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
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (!communityName.trim() || working) && styles.disabled,
                ]}
                disabled={!communityName.trim() || working}
                onPress={() => void handleCreate()}
              >
                <Text style={styles.primaryButtonText}>
                  {working ? 'building community…' : 'create community'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.formTitle}>Open an invite</Text>
              <Text style={styles.formHint}>
                Paste a buzzrouter.com link. You will see the community before joining.
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
                placeholder="https://buzzrouter.com/join/…"
                placeholderTextColor={groknight.dim}
              />
              <TouchableOpacity
                style={[styles.primaryButton, !inviteInput.trim() && styles.disabled]}
                disabled={!inviteInput.trim()}
                onPress={handleJoin}
              >
                <Text style={styles.primaryButtonText}>inspect invite</Text>
              </TouchableOpacity>
            </>
          )}

          {error && (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
          )}
        </View>
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
    paddingHorizontal: 12,
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
  modeSwitch: {
    marginHorizontal: 16,
    marginTop: 22,
    padding: 3,
    flexDirection: 'row',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  modeButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
  },
  modeButtonActive: {
    backgroundColor: groknight.bgHighlight,
    borderWidth: 1,
    borderColor: groknight.accent,
  },
  modeText: { color: groknight.muted, fontFamily: mono, fontSize: 12, fontWeight: '700' },
  modeTextActive: { color: groknight.accent },
  form: { paddingHorizontal: 18, paddingTop: 32 },
  formTitle: { color: groknight.textPrimary, fontSize: 20, fontWeight: '800' },
  formHint: {
    marginTop: 8,
    maxWidth: 460,
    color: groknight.muted,
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 18,
  },
  input: {
    minHeight: 48,
    marginTop: 22,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontFamily: mono,
    fontSize: 14,
  },
  inviteInput: { fontSize: 11 },
  primaryButton: {
    minHeight: 46,
    marginTop: 12,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.accent,
  },
  primaryButtonText: {
    color: groknight.bgTerminal,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '800',
  },
  disabled: { opacity: 0.42 },
  errorText: {
    marginTop: 14,
    color: groknight.chrome,
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 17,
  },
});
