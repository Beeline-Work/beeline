import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Identity } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import {
  buildCommunityInviteUrl,
  resolveCommunityInvitePublicOrigin,
} from '@/buzz/community-invite';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { enterWorkspaceRoom } from '@/buzz/enter-workspace';
import { defaultFaceForSeed, type FaceId } from '@/buzz/faces';
import { savePreferredPersonName } from '@/buzz/person-name';
import { offerProductTour } from '@/buzz/product-tour';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { BrassButton, MonoButton } from '@/components/buzz/MonoHull';
import { FaceGrid } from '@/components/buzz/FaceGrid';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

type Step = 1 | 2 | 3;
const STEP_LABELS: Record<Step, string> = {
  1: WORKSPACE_LABEL,
  2: 'Your profile',
  3: 'Bring your crew',
};
const CONNECT_AGENT_COMMAND = 'npx usebeeline connect';

/**
 * Create a Workspace in three short steps (Slack's pacing, Beeline's
 * identity rules): the Workspace's name and optional picture; the person's
 * name and Beeline face — never a photo; then optional invitations and a
 * first agent. The Workspace — with its public `#general` — is created the
 * moment step 1 is confirmed, under an id chosen once here, so a retried or
 * interrupted create never makes a second one, and leaving at any later step
 * still lands the person in a working Workspace. Finishing (or skipping)
 * opens `#general` and offers the product tour.
 */
export default function CreateWorkspace() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const workspaceId = useRef(Crypto.randomUUID()).current;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [workspaceName, setWorkspaceName] = useState('');
  const [picture, setPicture] = useState<string | null>(null);
  const [personName, setPersonName] = useState('');
  const [face, setFace] = useState<FaceId | null>(null);
  const [savedProfile, setSavedProfile] = useState<{ name: string; face: string | null } | null>(
    null,
  );
  const [roomId, setRoomId] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState<'invite' | 'agent' | null>(null);
  const [working, setWorking] = useState<
    null | 'picture' | 'create' | 'profile' | 'invite' | 'agent'
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await loadBuzzIdentity();
      if (!current) {
        router.replace('/beeline/onboarding');
        return;
      }
      if (cancelled) return;
      setIdentity(current);
      const managed = await monolithPhoneOperation('getManagedIdentity', {}).catch(() => null);
      if (cancelled || !managed) return;
      setPersonName(managed.name);
      setFace((managed.face as FaceId | undefined) ?? null);
      setSavedProfile({ name: managed.name, face: managed.face ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choosePicture = useCallback(async () => {
    if (!identity || working) return;
    setWorking('picture');
    setError(null);
    try {
      const client = await new BuzzRigTransport(identity).ensureClient();
      const uploaded = await pickAndUploadAvatar(client);
      if (uploaded) setPicture(uploaded);
    } catch (reason) {
      setError(
        `Could not use that picture: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setWorking(null);
    }
  }, [identity, working]);

  const createWorkspace = useCallback(async () => {
    const name = workspaceName.trim();
    if (!identity || !name || working) return;
    setWorking('create');
    setError(null);
    setNotice(null);
    try {
      const created = await monolithPhoneOperation('createWorkspace', { workspaceId, name });
      await saveActiveCommunityId(identity.publicKey, created.id);
      setRoomId(created.roomId ?? null);
      if (picture) {
        // The picture is optional: a failure here never blocks setup.
        await monolithPhoneOperation('updateWorkspace', { workspaceId, avatar: picture }).catch(
          () => setNotice('Your picture did not save. You can set it later in Workspace Settings.'),
        );
      }
      setStep(2);
    } catch (reason) {
      setError(
        `Could not create ${WORKSPACE_LABEL}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setWorking(null);
    }
  }, [identity, picture, workspaceId, workspaceName, working]);

  const saveProfile = useCallback(async () => {
    const name = personName.trim();
    if (!identity || !name || working) return;
    setWorking('profile');
    setError(null);
    try {
      if (name !== savedProfile?.name) {
        await monolithPhoneOperation('updatePersonProfile', { name });
        await savePreferredPersonName(identity.publicKey, name).catch(() => undefined);
      }
      const chosen = face ?? defaultFaceForSeed(identity.publicKey);
      if (chosen !== savedProfile?.face)
        await monolithPhoneOperation('updateIdentityFace', { faceId: chosen });
      setSavedProfile({ name, face: chosen });
      setStep(3);
    } catch (reason) {
      setError(
        `Could not save your profile: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setWorking(null);
    }
  }, [face, identity, personName, savedProfile, working]);

  const shareInvite = useCallback(async () => {
    if (working) return;
    setError(null);
    try {
      let url = inviteUrl;
      if (!url) {
        setWorking('invite');
        const relayUrl = await getEffectiveRelayUrl();
        const invite = await monolithPhoneOperation('createInvite', { workspaceId });
        url = buildCommunityInviteUrl(
          invite.token,
          resolveCommunityInvitePublicOrigin(relayUrl, getBuzzRuntimeConfig()),
        );
        setInviteUrl(url);
      }
      // Copying and the share sheet are conveniences: the link is on screen
      // either way, and a browser that refuses the clipboard is not a failure.
      const copiedOk = await (
        await import('expo-clipboard')
      )
        .setStringAsync(url)
        .then(() => true)
        .catch(() => false);
      if (copiedOk) setCopied('invite');
      await Share.share({ message: url }).catch(() => undefined);
    } catch (reason) {
      setError(
        `Could not create an invite: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setWorking(null);
    }
  }, [inviteUrl, workspaceId, working]);

  const connectAgent = useCallback(async () => {
    if (working) return;
    setError(null);
    try {
      let command = pairCommand;
      if (!command) {
        setWorking('agent');
        const pairing = await monolithPhoneOperation('createAgentPairingCode', { workspaceId });
        command = `${CONNECT_AGENT_COMMAND} ${pairing.code}`;
        setPairCommand(command);
      }
      const copiedOk = await (
        await import('expo-clipboard')
      )
        .setStringAsync(command)
        .then(() => true)
        .catch(() => false);
      if (copiedOk) setCopied('agent');
    } catch (reason) {
      setError(
        `Could not create an agent invite: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setWorking(null);
    }
  }, [pairCommand, workspaceId, working]);

  const finish = useCallback(async () => {
    if (!identity) return;
    await offerProductTour(identity.publicKey);
    enterWorkspaceRoom(workspaceId, roomId);
  }, [identity, roomId, workspaceId]);

  const back = () => {
    setError(null);
    if (step === 1) {
      if (router.canGoBack()) router.back();
      else router.replace('/beeline/community');
    } else setStep((step - 1) as Step);
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
          {step !== 3 ? (
            <TouchableOpacity
              accessibilityLabel="Back"
              accessibilityRole="button"
              onPress={back}
              style={styles.backButton}
              testID="create-back"
            >
              <ChevronGlyph color={theme.buzz.chrome} direction="left" size={CHEVRON_BACK_SIZE} />
            </TouchableOpacity>
          ) : null}
          <View
            accessibilityLabel={`Step ${step} of 3`}
            accessible
            style={styles.progress}
            testID="create-progress"
          >
            {([1, 2, 3] as const).map((index) => (
              <View
                key={index}
                style={[styles.progressBar, index <= step && styles.progressBarOn]}
              />
            ))}
          </View>
          <Text style={styles.eyebrow}>{`${STEP_LABELS[step]} · ${step} of 3`}</Text>

          {step === 1 ? (
            <View testID="create-step-workspace">
              <Text accessibilityRole="header" style={styles.title}>
                What should we call it?
              </Text>
              <Text style={styles.copy}>
                Use your company, project, or team name. You can change it later.
              </Text>
              <Text style={styles.label}>{`${WORKSPACE_LABEL} name`.toUpperCase()}</Text>
              <TextInput
                accessibilityLabel={`${WORKSPACE_LABEL} name`}
                autoFocus
                editable={working !== 'create'}
                maxLength={80}
                onChangeText={setWorkspaceName}
                onSubmitEditing={() => void createWorkspace()}
                placeholder="Northstar Lab"
                placeholderTextColor={theme.buzz.textDisabled}
                style={styles.input}
                testID="create-workspace-name"
                value={workspaceName}
              />
              <Pressable
                accessibilityHint="Optional. A square image works best."
                accessibilityRole="button"
                disabled={working !== null}
                onPress={() => void choosePicture()}
                style={styles.pictureRow}
                testID="create-workspace-picture"
              >
                <IdentityMark
                  avatarUrl={picture ?? undefined}
                  kind="workspace"
                  name={workspaceName.trim() || WORKSPACE_LABEL}
                  seed={workspaceId}
                  size={64}
                />
                <View style={styles.pictureCopy}>
                  <Text style={styles.pictureAction}>
                    {working === 'picture'
                      ? 'Uploading…'
                      : picture
                        ? 'Change picture'
                        : 'Add a picture'}
                  </Text>
                  <Text style={styles.hint}>Optional · square image works best</Text>
                </View>
              </Pressable>
              <BrassButton
                disabled={!workspaceName.trim() || working !== null}
                label={working === 'create' ? `Creating ${WORKSPACE_LABEL}` : 'Continue'}
                loading={working === 'create'}
                onPress={() => void createWorkspace()}
                testID="create-continue"
              />
            </View>
          ) : null}

          {step === 2 && identity ? (
            <View testID="create-step-profile">
              <Text accessibilityRole="header" style={styles.title}>
                How should people know you?
              </Text>
              <Text style={styles.copy}>
                Use the name your collaborators will recognize, then choose your face.
              </Text>
              <Text style={styles.label}>YOUR NAME</Text>
              <TextInput
                accessibilityLabel="Your name"
                maxLength={80}
                onChangeText={setPersonName}
                placeholder="Jordan Lee"
                placeholderTextColor={theme.buzz.textDisabled}
                style={styles.input}
                testID="create-person-name"
                value={personName}
              />
              <Text style={styles.label}>CHOOSE YOUR FACE</Text>
              <View style={styles.faces}>
                <FaceGrid
                  onSelect={setFace}
                  seed={identity.publicKey}
                  selected={face ?? defaultFaceForSeed(identity.publicKey)}
                  testIDPrefix="create-face"
                />
              </View>
              <BrassButton
                disabled={!personName.trim() || working !== null}
                label="Continue"
                loading={working === 'profile'}
                onPress={() => void saveProfile()}
                testID="create-continue"
              />
            </View>
          ) : null}

          {step === 3 ? (
            <View testID="create-step-crew">
              <Text accessibilityRole="header" style={styles.title}>
                You don’t have to work alone.
              </Text>
              <Text style={styles.copy}>
                Invite a person or connect an agent now. You can do both later.
              </Text>
              <View style={styles.crewCard}>
                <Text style={styles.crewTitle}>Invite people</Text>
                <Text style={styles.hint}>
                  Share a private link. Anyone with it can join for seven days.
                </Text>
                {inviteUrl ? (
                  <Text selectable style={styles.machine} testID="create-invite-url">
                    {inviteUrl}
                  </Text>
                ) : null}
                <MonoButton
                  disabled={working !== null}
                  variant="secondary"
                  label={
                    copied === 'invite'
                      ? 'Link copied'
                      : inviteUrl
                        ? 'Copy invite link'
                        : 'Create invite link'
                  }
                  loading={working === 'invite'}
                  onPress={() => void shareInvite()}
                  testID="create-invite"
                />
              </View>
              <View style={styles.crewCard}>
                <Text style={styles.crewTitle}>Connect your first agent</Text>
                <Text style={styles.hint}>Run this on the machine where your agent works.</Text>
                {pairCommand ? (
                  <Text selectable style={styles.machine} testID="create-agent-command">
                    {pairCommand}
                  </Text>
                ) : null}
                <MonoButton
                  disabled={working !== null}
                  variant="secondary"
                  label={
                    copied === 'agent'
                      ? 'Command copied'
                      : pairCommand
                        ? 'Copy command'
                        : 'Get connect command'
                  }
                  loading={working === 'agent'}
                  onPress={() => void connectAgent()}
                  testID="create-agent"
                />
              </View>
              <BrassButton
                label="Finish setup"
                onPress={() => void finish()}
                testID="create-finish"
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => void finish()}
                style={styles.skip}
                testID="create-skip"
              >
                <Text style={styles.skipText}>Skip for now</Text>
              </Pressable>
            </View>
          ) : null}

          {notice ? (
            <Text accessibilityRole="alert" style={styles.hint} testID="create-notice">
              {notice}
            </Text>
          ) : null}
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
    progress: { flexDirection: 'row', gap: hull.space.xs, marginBottom: hull.space.md },
    progressBar: { width: 28, height: 2, backgroundColor: hull.borderStrong },
    progressBarOn: { backgroundColor: hull.accent },
    eyebrow: { ...Typography.default(), ...hull.type.sectionHead, color: hull.accent },
    title: {
      ...Typography.default(),
      ...hull.type.hero,
      color: hull.textPrimary,
      marginTop: hull.space.sm,
    },
    copy: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textSecondary,
      marginTop: hull.space.sm,
      marginBottom: hull.space.lg,
    },
    label: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.ledgerQuiet,
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
    pictureRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      minHeight: 64,
      marginBottom: hull.space.lg,
    },
    pictureCopy: { flex: 1, gap: hull.space.xs },
    pictureAction: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.accent },
    hint: { ...Typography.default(), ...hull.type.meta, color: hull.ledgerQuiet },
    faces: { alignItems: 'center', marginBottom: hull.space.lg },
    crewCard: {
      gap: hull.space.sm,
      padding: hull.space.md,
      marginBottom: hull.space.md,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.border,
    },
    crewTitle: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    machine: {
      ...Typography.mono(),
      ...hull.type.machine,
      color: hull.textSecondary,
      padding: hull.space.sm,
      borderRadius: hull.radius,
      backgroundColor: hull.bgCode,
    },
    skip: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: hull.space.xs,
    },
    skipText: { ...Typography.default(), ...hull.type.body, color: hull.ledgerQuiet },
    error: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
