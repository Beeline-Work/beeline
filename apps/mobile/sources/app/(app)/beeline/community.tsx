import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isWorkspaceListView, type Identity, type WorkspaceListView } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { parseCommunityInviteToken } from '@/buzz/community-invite';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { Typography } from '@/constants/Typography';
import { BrassButton } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { CHEVRON_BACK_SIZE, CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';
import { MembersGlyph } from '@/components/buzz/MembersGlyph';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Where a person arrives with no Workspace — and where the rail's "+" leads
 * everyone else: two equal paths, Create a Workspace or Join with an invite
 * link. Neither is emphasized over the other. An invite deep link never
 * reaches this screen: it goes straight to its own confirmation.
 */
export default function WorkspaceChoice() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const requestedMode = first(useLocalSearchParams<{ mode?: string | string[] }>().mode);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [workspaceList, setWorkspaceList] = useState<WorkspaceListView | null>(null);
  const [joinOpen, setJoinOpen] = useState(requestedMode === 'join');
  const [inviteInput, setInviteInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const communities = useMemo(
    () => workspaceList?.workspaces.map(workspaceRailItem) ?? [],
    [workspaceList],
  );
  const hasWorkspaces = communities.length > 0;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/beeline/onboarding');
          return;
        }
        const relayUrl = await getEffectiveRelayUrl();
        const address = surfaceAddress(relayUrl, currentIdentity.publicKey, '/workspaces');
        const cached = await mobileSurfaceCache.read(address, isWorkspaceListView);
        if (cancelled) return;
        setIdentity(currentIdentity);
        if (cached) setWorkspaceList(cached);
        const fresh = await new RoomViewClient({ baseUrl: relayUrl, identity: currentIdentity })
          .workspaces()
          .catch(() => null);
        if (cancelled || !fresh) return;
        setWorkspaceList(fresh);
        void mobileSurfaceCache.write(address, fresh, isWorkspaceListView);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleJoin = useCallback(() => {
    const token = parseCommunityInviteToken(inviteInput);
    if (!token) {
      setError('That is not a Beeline invite link. Paste the whole link you were sent.');
      return;
    }
    setError(null);
    router.push({ pathname: '/join/[token]', params: { token } });
  }, [inviteInput]);

  const selectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({ pathname: '/beeline/channels', params: { communityId } });
  }, []);

  if (!identity && !error) {
    return (
      <View style={[styles.loading, { paddingTop: insets.top }]}>
        <SurfaceGlyphLoader testID="community-loader" />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={null}
      onSelect={selectCommunity}
      onAdd={() => undefined}
      onSettings={() => router.push('/beeline/settings' as Href)}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={workspaceList?.viewer.avatar}
      viewerFace={workspaceList?.viewer.face}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + theme.buzz.space.lg }]}
        keyboardShouldPersistTaps="handled"
        style={styles.container}
        testID="workspace-choice"
      >
        <View style={styles.column}>
          {hasWorkspaces ? (
            <TouchableOpacity
              accessibilityLabel="Back"
              accessibilityRole="button"
              onPress={() =>
                router.canGoBack() ? router.back() : router.replace('/beeline/channels')
              }
              style={styles.backButton}
            >
              <ChevronGlyph color={theme.buzz.chrome} direction="left" size={CHEVRON_BACK_SIZE} />
            </TouchableOpacity>
          ) : null}
          <Text style={styles.eyebrow}>Welcome to Beeline</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Where are you headed?
          </Text>
          <Text style={styles.copy}>
            Start a {WORKSPACE_LABEL.toLowerCase()} for your team, or use an invite you already
            have.
          </Text>

          <View style={styles.choices}>
            <ChoiceCard
              description="Name it, invite your people, connect an agent."
              glyph={<RoomGlyph color={theme.buzz.accent} size={20} />}
              onPress={() => router.push('/beeline/create-workspace' as Href)}
              testID="choice-create"
              title={`Create a ${WORKSPACE_LABEL}`}
            />
            <ChoiceCard
              description="Paste the link someone sent you."
              expanded={joinOpen}
              glyph={<MembersGlyph color={theme.buzz.accent} size={20} />}
              onPress={() => {
                setJoinOpen((open) => !open);
                setError(null);
              }}
              testID="choice-join"
              title="Join with an invite link"
            />
            {joinOpen ? (
              <View style={styles.joinForm} testID="choice-join-form">
                <TextInput
                  accessibilityLabel="Invite link"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  keyboardType="url"
                  onChangeText={setInviteInput}
                  onSubmitEditing={handleJoin}
                  placeholder="https://usebeeline.app/join/…"
                  placeholderTextColor={theme.buzz.textDisabled}
                  style={styles.input}
                  testID="choice-join-input"
                  value={inviteInput}
                />
                <BrassButton
                  disabled={!inviteInput.trim()}
                  label="Preview invite"
                  onPress={handleJoin}
                  testID="choice-join-preview"
                />
              </View>
            ) : null}
          </View>

          {error ? (
            <Text accessibilityRole="alert" style={styles.error} testID="choice-error">
              {error}
            </Text>
          ) : null}
          {!hasWorkspaces ? (
            <>
              <Text style={styles.footnote}>
                Already use Beeline? {WORKSPACE_LABEL}s you belong to appear here as soon as someone
                adds you.
              </Text>
              <Pressable
                accessibilityRole="link"
                onPress={() => router.push('/beeline/settings' as Href)}
                style={styles.settingsLink}
                testID="choice-settings"
              >
                <Text style={styles.settingsLinkText}>Account settings</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </ScrollView>
    </BuzzCommunityShell>
  );
}

function ChoiceCard({
  title,
  description,
  glyph,
  onPress,
  expanded,
  testID,
}: {
  title: string;
  description: string;
  glyph: React.ReactNode;
  onPress: () => void;
  expanded?: boolean;
  testID: string;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityHint={description}
      accessibilityRole="button"
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      testID={testID}
    >
      <View style={styles.cardGlyph}>{glyph}</View>
      <View style={styles.cardCopy}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardDescription}>{description}</Text>
      </View>
      <ChevronGlyph
        color={theme.buzz.accent}
        direction={expanded ? 'down' : 'right'}
        size={CHEVRON_ROW_SIZE}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    loading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: hull.bgTerminal,
    },
    container: { flex: 1, minWidth: 0, backgroundColor: hull.bgTerminal },
    scroll: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
      paddingBottom: hull.space.xxl,
    },
    column: { width: '100%', maxWidth: 460, alignSelf: 'center' },
    backButton: {
      width: 44,
      height: 44,
      marginLeft: -hull.space.sm,
      marginBottom: hull.space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    eyebrow: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.accent,
      marginBottom: hull.space.sm,
    },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    copy: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textSecondary,
      marginTop: hull.space.sm,
    },
    choices: { marginTop: hull.space.lg, gap: hull.space.sm },
    card: {
      minHeight: 76,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      padding: hull.space.md,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      backgroundColor: hull.bgRaised,
    },
    cardPressed: { backgroundColor: hull.bgPressed },
    cardGlyph: {
      width: 42,
      height: 42,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.border,
    },
    cardCopy: { flex: 1, minWidth: 0, gap: hull.space.xs },
    cardTitle: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    cardDescription: { ...Typography.default(), ...hull.type.meta, color: hull.ledgerQuiet },
    joinForm: { gap: hull.space.sm, paddingTop: hull.space.xs },
    input: {
      ...Typography.mono(),
      ...hull.type.machine,
      minHeight: 48,
      paddingHorizontal: hull.space.md,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      color: hull.textPrimary,
      backgroundColor: hull.bgBase,
    },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginTop: hull.space.md,
    },
    settingsLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    settingsLinkText: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    footnote: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      marginTop: hull.space.lg,
    },
  };
});
