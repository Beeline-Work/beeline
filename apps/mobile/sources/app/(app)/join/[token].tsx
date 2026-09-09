import React, { useCallback, useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useURL } from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Identity } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { parseCommunityInviteToken, resolveCommunityInviteRelayUrl } from '@/buzz/community-invite';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { PixelLoader } from '@/components/buzz/MonoHull';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { workspaceRailItem } from '@/buzz/room-view-presentation';

export default function CommunityInviteJoin() {
  const insets = useSafeAreaInsets();
  const { token: routeToken } = useLocalSearchParams<{ token?: string | string[] }>();
  const incomingUrl = useURL();
  const token = parseCommunityInviteToken(routeToken);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [preview, setPreview] = useState<{ name: string } | null>(null);
  const [communities, setCommunities] = useState<
    { communityId: string; name: string; avatar?: string }[]
  >([]);
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
        if (!currentIdentity) {
          router.replace('/beeline/onboarding');
          return;
        }
        const view = new RoomViewClient({ baseUrl: url, identity: currentIdentity });
        const [nextPreview, available] = await Promise.all([
          view.invite(token).then((value) => ({ name: value.name })),
          view.workspaces().then((value) => value.workspaces.map(workspaceRailItem)),
        ]);
        if (!cancelled) {
          setIdentity(currentIdentity);
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
    if (!token || !preview || !identity) return;
    setJoining(true);
    setError(null);
    try {
      const redemption = await monolithPhoneOperation('redeemInvite', { token });
      await saveActiveCommunityId(identity.publicKey, redemption.workspaceId);
      router.replace({
        pathname: '/beeline/channels',
        params: { communityId: redemption.workspaceId },
      });
    } catch (err) {
      setError(`Could not join: ${String(err)}`);
    } finally {
      setJoining(false);
    }
  }, [identity, preview, token]);
  const previewName = preview?.name;

  const selectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/beeline/channels',
      params: { communityId },
    });
  }, []);

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={null}
      onSelect={selectCommunity}
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
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
                  {previewName!.slice(0, 2).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.title}>Join {previewName}?</Text>
              <Text style={styles.details}>Open its {ROOM_LABEL}s and work with its Agents.</Text>

              <TouchableOpacity
                testID="confirm-community-join"
                style={[styles.primaryButton, joining && styles.disabled]}
                disabled={joining}
                onPress={() => void handleJoin()}
              >
                <Text style={styles.primaryButtonText}>
                  {joining ? 'Joining…' : `Join ${previewName}`}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => router.replace('/beeline/channels')}
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
                onPress={() => router.replace('/beeline/channels')}
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

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
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
  };
});
