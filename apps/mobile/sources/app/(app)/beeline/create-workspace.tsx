import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Identity } from '@beeline/buzz-client';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { enterWorkspaceRoom } from '@/buzz/enter-workspace';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { OnboardingButton } from '@/components/buzz/MonoHull';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * Create a Workspace in one step: its name. The Workspace — with its public
 * `#general` — is created under an id chosen once here, so a retried create
 * never makes a second one, and the person lands straight in `#general`.
 * The picture, invites and agents all live in the Workspace itself.
 */
export default function CreateWorkspace() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const workspaceId = useRef(Crypto.randomUUID()).current;
  // A create is attempted before its answer is known, so what the server
  // HOLDS is only what a call has confirmed: null means unknown, and an
  // unknown name is rewritten rather than assumed.
  const createAttempted = useRef(false);
  const confirmedName = useRef<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await loadBuzzIdentity();
      if (!current) {
        router.replace('/beeline/onboarding');
        return;
      }
      if (!cancelled) setIdentity(current);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const createWorkspace = useCallback(async () => {
    const name = workspaceName.trim();
    if (!identity || !name || working) return;
    setWorking(true);
    setError(null);
    const firstAttempt = !createAttempted.current;
    createAttempted.current = true;
    try {
      const created = await monolithPhoneOperation('createWorkspace', { workspaceId, name });
      // The create is idempotent on this id: only the first attempt can have
      // inserted this name, so a retry after an edit writes the rename.
      if (firstAttempt) confirmedName.current = name;
      if (confirmedName.current !== name) {
        await monolithPhoneOperation('updateWorkspace', { workspaceId, name });
        confirmedName.current = name;
      }
      await saveActiveCommunityId(identity.publicKey, created.id);
      enterWorkspaceRoom(workspaceId, created.roomId ?? null);
    } catch (reason) {
      setError(
        `Could not create ${WORKSPACE_LABEL}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
      setWorking(false);
    }
  }, [identity, workspaceId, workspaceName, working]);

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/beeline/community');
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="create-workspace">
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + theme.buzz.space.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <TouchableOpacity
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={back}
            style={styles.backButton}
            testID="create-back"
          >
            <ChevronGlyph color={theme.buzz.chrome} direction="left" size={CHEVRON_BACK_SIZE} />
          </TouchableOpacity>
          <View testID="create-step-workspace">
            <Text accessibilityRole="header" style={styles.title}>
              {`Name your ${WORKSPACE_LABEL}`}
            </Text>
            <Text style={styles.copy}>Your team, company, or project. Change it in Settings.</Text>
            <Text style={styles.label}>{`${WORKSPACE_LABEL} name`}</Text>
            <TextInput
              accessibilityLabel={`${WORKSPACE_LABEL} name`}
              autoFocus
              editable={!working}
              maxLength={80}
              onChangeText={setWorkspaceName}
              onSubmitEditing={() => void createWorkspace()}
              placeholder="Northstar Lab"
              placeholderTextColor={theme.buzz.textDisabled}
              style={styles.input}
              testID="create-workspace-name"
              value={workspaceName}
            />
            <OnboardingButton
              disabled={!workspaceName.trim() || working}
              label={`Create ${WORKSPACE_LABEL}`}
              loading={working}
              onPress={() => void createWorkspace()}
              testID="create-continue"
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error} testID="create-error">
              {error}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    scroll: { flexGrow: 1, paddingHorizontal: hull.space.md, paddingTop: hull.space.lg },
    column: { width: '100%', maxWidth: 460, alignSelf: 'center', gap: hull.space.sm },
    backButton: {
      width: 44,
      height: 44,
      marginLeft: -hull.space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...Typography.default(),
      ...hull.type.hero,
      color: hull.textPrimary,
      marginTop: hull.space.sm,
    },
    copy: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textSecondary,
      marginTop: hull.space.sm,
      marginBottom: hull.space.lg,
    },
    label: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textSecondary,
      marginBottom: hull.space.sm,
    },
    input: {
      ...Typography.default(),
      ...hull.type.body,
      minHeight: 48,
      paddingHorizontal: hull.space.md,
      marginBottom: hull.space.lg,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      color: hull.textPrimary,
      backgroundColor: hull.bgBase,
    },
    error: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
