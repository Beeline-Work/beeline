import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useURL } from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBuzzClient, type Community, type Identity } from '@beeline/buzz-client';
import {
  generateBuzzIdentity,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import {
  loadCommunityInvitePreview,
  parseCommunityInviteToken,
  resolveCommunityInviteRelayUrl,
  type CommunityInvitePreview,
} from '@/buzz/community-invite';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import {
  ensurePersonNameForWorkspace,
  resolveOnboardingPersonName,
  savePreferredPersonName,
} from '@/buzz/person-name';
import { groknight } from '@/buzz/groknight';
import { ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { Typography } from '@/constants/Typography';
import { PixelLoader } from '@/components/buzz/MonoHull';

export default function CommunityInviteJoin() {
  const insets = useSafeAreaInsets();
  const { token: routeToken } = useLocalSearchParams<{ token?: string | string[] }>();
  const incomingUrl = useURL();
  const token = parseCommunityInviteToken(routeToken);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<CommunityInvitePreview | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token) {
        setError('This invite link is malformed.');
        setLoading(false);
        return;
      }
      try {
        const [currentIdentity, configuredRelayUrl] = await Promise.all([
          loadBuzzIdentity(),
          getEffectiveRelayUrl(),
        ]);
        const url = resolveCommunityInviteRelayUrl(incomingUrl, token, configuredRelayUrl);
        const nextPreview = await loadCommunityInvitePreview(
          url,
          token,
          currentIdentity ?? undefined,
        );
        let available: Community[] = [];
        if (currentIdentity) {
          const client = createBuzzClient({ baseUrl: url, identity: currentIdentity });
          available = await client.listCommunities();
        }
        if (!cancelled) {
          setIdentity(currentIdentity);
          setRelayUrl(url);
          setPreview(nextPreview);
          setCommunities(available);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [incomingUrl, token]);

  const handleJoin = useCallback(async () => {
    if (!token || !relayUrl || !preview) return;
    if (!identity && !displayName.trim()) {
      setError('Choose a name to create your key and join.');
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const joiningIdentity = identity ?? (await generateBuzzIdentity(displayName.trim()));
      if (!identity) await registerBuzzPushNotifications(joiningIdentity);
      const client = createBuzzClient({ baseUrl: relayUrl, identity: joiningIdentity });
      if (identity) {
        await resolveOnboardingPersonName(client, joiningIdentity.publicKey);
      } else {
        await savePreferredPersonName(joiningIdentity.publicKey, displayName);
      }
      const redemption = await client.redeemInvite(token);
      await client.waitUntilMember(redemption.communityId, joiningIdentity.publicKey);
      await ensurePersonNameForWorkspace(client, redemption.communityId, joiningIdentity.publicKey);
      const community = await client.getCommunity(redemption.communityId);
      if (!community)
        throw new Error(`Joined, but ${WORKSPACE_LABEL} details are not visible yet.`);
      await saveActiveCommunityId(joiningIdentity.publicKey, community.communityId);
      router.replace({
        pathname: '/buzz/channels',
        params: { communityId: community.communityId },
      });
    } catch (err) {
      setError(`Could not join: ${String(err)}`);
    } finally {
      setJoining(false);
    }
  }, [displayName, identity, preview, relayUrl, token]);

  const selectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={null}
      onSelect={selectCommunity}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.topbar}>
          <TouchableOpacity
            accessibilityLabel="Back"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.topbarTitle}>Invite</Text>
        </View>

        <View style={styles.content}>
          {loading ? (
            <View style={styles.loadingBlock}>
              <PixelLoader compact />
              <Text style={styles.loadingText}>verifying signed invite…</Text>
            </View>
          ) : preview ? (
            <>
              <View style={styles.communityMark}>
                <Text style={styles.communityMarkText}>
                  {preview.community.name.slice(0, 2).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.title}>Join {preview.community.name}?</Text>
              <Text style={styles.details}>Open its {ROOM_LABEL}s and work with its Agents.</Text>

              {!identity && (
                <View style={styles.identityForm}>
                  <Text style={styles.identityLabel}>Your name</Text>
                  <TextInput
                    autoFocus
                    style={styles.input}
                    value={displayName}
                    onChangeText={setDisplayName}
                    onSubmitEditing={() => void handleJoin()}
                    editable={!joining}
                    maxLength={60}
                    placeholder="Ada"
                    placeholderTextColor={groknight.dim}
                  />
                  <Text style={styles.identityHint}>
                    Your private identity key stays on this device.
                  </Text>
                </View>
              )}

              <TouchableOpacity
                testID="confirm-community-join"
                style={[
                  styles.primaryButton,
                  (joining || (!identity && !displayName.trim())) && styles.disabled,
                ]}
                disabled={joining || (!identity && !displayName.trim())}
                onPress={() => void handleJoin()}
              >
                <Text style={styles.primaryButtonText}>
                  {joining ? 'Joining…' : `Join ${preview.community.name}`}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => router.replace('/buzz/channels')}
              >
                <Text style={styles.cancelText}>Not now</Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.failureBlock}>
              <Text style={styles.failureTitle}>Invite unavailable</Text>
              <Text style={styles.details}>{error ?? 'This invite could not be opened.'}</Text>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => router.replace('/buzz/channels')}
              >
                <Text style={styles.cancelText}>Return to Beeline</Text>
              </TouchableOpacity>
            </View>
          )}

          {preview && error && (
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
  container: { flex: 1, minWidth: 0, backgroundColor: groknight.bgTerminal },
  topbar: {
    minHeight: 58,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: groknight.bgBase,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  backButton: { width: 34, height: 42, alignItems: 'center', justifyContent: 'center' },
  backText: { color: groknight.chrome, fontSize: 30, fontWeight: '300' },
  topbarTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  content: { flex: 1, paddingHorizontal: 22, paddingTop: 48, alignItems: 'center' },
  loadingBlock: { alignItems: 'center', paddingTop: 54 },
  loadingText: { marginTop: 13, color: groknight.muted, fontSize: 11 },
  communityMark: {
    width: 68,
    height: 68,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: groknight.selectedBorder,
    backgroundColor: groknight.bgHighlight,
  },
  communityMarkText: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
  },
  title: {
    marginTop: 24,
    color: groknight.textPrimary,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '900',
    textAlign: 'center',
  },
  details: {
    maxWidth: 430,
    marginTop: 10,
    color: groknight.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  identityForm: { alignSelf: 'stretch', marginTop: 28 },
  identityLabel: {
    marginBottom: 7,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 14,
  },
  identityHint: {
    marginTop: 7,
    color: groknight.dim,
    fontSize: 10,
    lineHeight: 14,
  },
  primaryButton: {
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: 24,
    paddingHorizontal: 14,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.actionFill,
  },
  primaryButtonText: {
    color: groknight.textInverted,
    fontSize: 13,
  },
  disabled: { opacity: 0.42 },
  cancelButton: {
    marginTop: 10,
    minHeight: 40,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: groknight.steel, fontSize: 12 },
  errorText: {
    marginTop: 14,
    color: groknight.chrome,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  failureBlock: { alignItems: 'center', paddingTop: 40 },
  failureTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
  },
});
