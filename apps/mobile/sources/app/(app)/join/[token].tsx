import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useURL } from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Identity } from '@beeline/buzz-client';
import type { InviteView } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { parseCommunityInviteToken, resolveCommunityInviteRelayUrl } from '@/buzz/community-invite';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { inviteSummary, inviterRoleLabel } from '@/buzz/invite-summary';
import { enterWorkspaceRoom } from '@/buzz/enter-workspace';
import { clearPendingInvite, savePendingInvite } from '@/buzz/pending-invite';
import { offerProductTour } from '@/buzz/product-tour';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { BrassButton } from '@/components/buzz/MonoHull';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * A verified invite link skips the create-or-join choice entirely: it names
 * the Workspace and who invited you, one confirmation joins it, and the
 * first Room you can open opens. Opened before sign-in, the link is kept on
 * the device and comes back here after sign-in. A link that no longer works
 * shows its own repair state, with a way to the choice screen.
 */
export default function CommunityInviteJoin() {
  const insets = useSafeAreaInsets();
  const { token: routeToken } = useLocalSearchParams<{ token?: string | string[] }>();
  const incomingUrl = useURL();
  const token = parseCommunityInviteToken(routeToken);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [preview, setPreview] = useState<InviteView | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token) {
        await clearPendingInvite();
        setError('This invite link is malformed.');
        setLoading(false);
        return;
      }
      try {
        const [currentIdentity, configuredRelayUrl] = await Promise.all([
          loadBuzzIdentity(),
          getEffectiveRelayUrl(),
        ]);
        if (!currentIdentity) {
          // Keep the invite through the sign-in ceremony; the deck brings the
          // person back here once they have an identity.
          await savePendingInvite(token);
          router.replace('/beeline/onboarding');
          return;
        }
        // Resolving the invite spends the parked copy: this screen now owns it.
        await clearPendingInvite();
        const url = resolveCommunityInviteRelayUrl(incomingUrl, token, configuredRelayUrl);
        const view = new RoomViewClient({ baseUrl: url, identity: currentIdentity });
        const invite = await view.invite(token);
        if (invite.joinedWorkspaceId) {
          await saveActiveCommunityId(currentIdentity.publicKey, invite.joinedWorkspaceId);
          if (!cancelled) enterWorkspaceRoom(invite.joinedWorkspaceId, null);
          return;
        }
        if (!cancelled) {
          setIdentity(currentIdentity);
          setPreview(invite);
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
    if (!token || !preview || !identity || joinInFlight.current) return;
    joinInFlight.current = true;
    setJoining(true);
    setError(null);
    try {
      const redemption = await monolithPhoneOperation('redeemInvite', { token });
      await saveActiveCommunityId(identity.publicKey, redemption.workspaceId);
      if (redemption.joined) await offerProductTour(identity.publicKey);
      enterWorkspaceRoom(redemption.workspaceId, redemption.roomId);
    } catch (err) {
      joinInFlight.current = false;
      setError(`Could not join: ${String(err)}`);
    } finally {
      setJoining(false);
    }
  }, [identity, preview, token]);

  const otherWay = () => router.replace('/beeline/community');

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 48 }]}
      style={styles.container}
      testID="invite-join"
    >
      <View style={styles.column}>
        {loading ? (
          <View style={styles.loadingBlock}>
            <SurfaceGlyphLoader compact testID="invite-loader" />
            <Text style={styles.meta}>Checking your invite…</Text>
          </View>
        ) : preview ? (
          <>
            <View style={styles.badge}>
              <View style={styles.badgeDot} />
              <Text style={styles.badgeText}>INVITE VERIFIED</Text>
            </View>
            <IdentityMark
              avatarUrl={preview.avatar}
              kind="workspace"
              name={preview.name}
              seed={token ?? preview.name}
              size={68}
            />
            <Text accessibilityRole="header" style={styles.title} testID="invite-title">
              {`Join ${preview.name}`}
            </Text>
            <Text style={styles.body} testID="invite-summary">
              {inviteSummary(preview)}
            </Text>
            {preview.inviter ? (
              <View style={styles.inviter} testID="invite-inviter">
                <IdentityMark
                  face={preview.inviter.face}
                  kind="human"
                  name={preview.inviter.name}
                  seed={preview.inviter.handle ?? preview.inviter.name}
                  size={42}
                />
                <View style={styles.inviterCopy}>
                  <Text style={styles.inviterName}>{preview.inviter.name}</Text>
                  <Text style={styles.meta}>
                    {[
                      preview.inviter.handle ? `@${preview.inviter.handle}` : null,
                      inviterRoleLabel(preview.inviter.role),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
              </View>
            ) : null}
            <BrassButton
              disabled={joining}
              label={joining ? 'Joining…' : `Join ${preview.name}`}
              loading={joining}
              onPress={() => void handleJoin()}
              style={styles.primary}
              testID="confirm-community-join"
            />
            <Pressable
              accessibilityRole="button"
              onPress={otherWay}
              style={styles.quiet}
              testID="invite-not-mine"
            >
              <Text style={styles.quietText}>This isn’t my invite</Text>
            </Pressable>
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
          </>
        ) : (
          <View style={styles.failureBlock} testID="invite-unavailable">
            <Text accessibilityRole="header" style={styles.title}>
              This invite doesn’t work anymore
            </Text>
            <Text style={styles.body}>
              It may have expired, been used up, or been withdrawn. Ask for a new link, or start
              your own {WORKSPACE_LABEL.toLowerCase()}.
            </Text>
            <BrassButton
              label="Choose another way in"
              onPress={otherWay}
              style={styles.primary}
              testID="invite-other-way"
            />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    scroll: { flexGrow: 1, paddingHorizontal: hull.space.md, paddingBottom: hull.space.xxl },
    column: { width: '100%', maxWidth: 460, alignSelf: 'center', gap: hull.space.md },
    loadingBlock: { alignItems: 'center', gap: hull.space.md, paddingTop: hull.space.xxl },
    badge: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    badgeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: hull.accent },
    badgeText: { ...Typography.default(), ...hull.type.sectionHead, color: hull.accent },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    body: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    meta: { ...Typography.default(), ...hull.type.meta, color: hull.ledgerQuiet },
    inviter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      padding: hull.space.md,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.border,
    },
    inviterCopy: { flex: 1, gap: hull.space.xs },
    inviterName: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    primary: { marginTop: hull.space.sm },
    quiet: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    quietText: { ...Typography.default(), ...hull.type.body, color: hull.ledgerQuiet },
    error: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
    failureBlock: { gap: hull.space.md },
  };
});
