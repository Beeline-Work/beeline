import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as QRCode from 'qrcode';
import Svg, { Path, Rect } from 'react-native-svg';
import {
  claimNip05Handle,
  fallbackPersonName,
  lookupRecovery,
  Nip05ClaimError,
  normalizeNip05Identifier,
  normalizePersonHandle,
  normalizePersonName,
  personHandle,
  type BuzzClient,
  type Identity,
} from '@beeline/buzz-client';
import {
  getEffectiveRelayUrl,
  loadBuzzIdentity,
  loadBuzzIdentityNsecForExport,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { loadActiveCommunityId } from '@/buzz/community-storage';
import { pickAndUploadAvatar } from '@/buzz/avatar-upload';
import { useVerifiedNip05Status } from '@/buzz/nip05-verification';
import {
  ensurePersonNameForWorkspace,
  loadPreferredPersonName,
  savePreferredPersonName,
} from '@/buzz/person-name';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { Typography } from '@/constants/Typography';
import { HullSurface, MonoButton, PixelGateReveal } from '@/components/buzz/MonoHull';
import { BuzzRigTransport } from '@/sync/transport';
import { getBuzzPushEnabled, setBuzzPushEnabled } from '@/push/buzz-push-registration';
import { getPushPermissionInfo, type PushPermissionInfo } from '@/sync/pushRegistration';
import { IdentityMark } from '@/components/buzz/IdentityMark';

const TYPED_CONFIRMATION = 'EXPORT';

type ConfirmationMethod = 'checking' | 'biometric' | 'typed';

function QrCode({ value }: { value: string }) {
  const { path, size } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const commands: string[] = [];

    for (let row = 0; row < qr.modules.size; row += 1) {
      let start = -1;
      for (let column = 0; column <= qr.modules.size; column += 1) {
        const filled = column < qr.modules.size && qr.modules.get(row, column) === 1;
        if (filled && start < 0) start = column;
        if (!filled && start >= 0) {
          commands.push(`M${start} ${row}h${column - start}v1H${start}z`);
          start = -1;
        }
      }
    }

    return { path: commands.join(''), size: qr.modules.size };
  }, [value]);

  const quietZone = 4;
  const viewBoxSize = size + quietZone * 2;

  return (
    <View
      accessible
      accessibilityLabel="QR code containing your Nostr secret key"
      style={styles.qrFrame}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}>
        <Rect width={viewBoxSize} height={viewBoxSize} fill={groknight.textPrimary} />
        <Path
          d={path}
          fill={groknight.bgTerminal}
          transform={`translate(${quietZone} ${quietZone})`}
        />
      </Svg>
    </View>
  );
}

export default function BuzzIdentitySettings() {
  const insets = useSafeAreaInsets();
  const [confirmationMethod, setConfirmationMethod] = useState<ConfirmationMethod>('checking');
  const [biometricLabel, setBiometricLabel] = useState('biometrics');
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileClient, setProfileClient] = useState<BuzzClient | null>(null);
  const [profileIdentity, setProfileIdentity] = useState<Identity | null>(null);
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [avatarWorking, setAvatarWorking] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [savedProfileName, setSavedProfileName] = useState('');
  const [profileHandle, setProfileHandle] = useState('');
  const [savedProfileHandle, setSavedProfileHandle] = useState('');
  const [profileNip05, setProfileNip05] = useState('');
  const [savedProfileNip05, setSavedProfileNip05] = useState('');
  const [nip05Focused, setNip05Focused] = useState(false);
  const [claimName, setClaimName] = useState('');
  const [claimWorking, setClaimWorking] = useState(false);
  const [claimStatus, setClaimStatus] = useState<'idle' | 'claimed' | 'taken' | 'invalid' | 'error'>(
    'idle',
  );
  const [nameWorking, setNameWorking] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [handleFocused, setHandleFocused] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [pushEnabled, setPushEnabledState] = useState<boolean | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
  const [pushWorking, setPushWorking] = useState(false);
  const [linkedGoogle, setLinkedGoogle] = useState<
    'checking' | 'connected' | 'not-linked' | 'unavailable'
  >('checking');
  const nip05Status = useVerifiedNip05Status(profilePubkey ?? '', { nip05: savedProfileNip05 });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) return;
        const transport = new BuzzRigTransport(identity, await getEffectiveRelayUrl());
        const client = await transport.ensureClient();
        const [communities, activeCommunityId, preferredName, enabled, permission] =
          await Promise.all([
            client.listCommunities(identity.publicKey),
            loadActiveCommunityId(identity.publicKey),
            loadPreferredPersonName(identity.publicKey),
            getBuzzPushEnabled(identity.publicKey),
            getPushPermissionInfo(),
          ]);
        const communityId = communities.some((item) => item.communityId === activeCommunityId)
          ? (activeCommunityId ?? undefined)
          : communities[0]?.communityId;
        const profile = communityId
          ? await ensurePersonNameForWorkspace(client, communityId, identity.publicKey)
          : await client.getGlobalPersonProfile(identity.publicKey);
        if (profile?.name && !preferredName) {
          await savePreferredPersonName(identity.publicKey, profile.name);
        }
        if (!cancelled) {
          setProfileClient(client);
          setProfileIdentity(identity);
          setProfilePubkey(identity.publicKey);
          setAvatarUrl(profile?.avatar);
          const nextName = profile?.name ?? preferredName ?? fallbackPersonName(identity.publicKey);
          const nextHandle = profile?.handle ?? personHandle(nextName, identity.publicKey);
          setProfileName(nextName);
          setSavedProfileName(nextName);
          setProfileHandle(nextHandle);
          setSavedProfileHandle(nextHandle);
          setProfileNip05(profile?.nip05 ?? '');
          setSavedProfileNip05(profile?.nip05 ?? '');
          setPushEnabledState(enabled);
          setPushPermission(permission);
        }
        try {
          const links = await lookupRecovery(getBuzzRuntimeConfig().relayUrl, identity);
          const google = links.some((link) => link.provider.includes('google.com'));
          if (!cancelled) setLinkedGoogle(google ? 'connected' : 'not-linked');
        } catch {
          if (!cancelled) setLinkedGoogle('unavailable');
        }
      } catch (caught) {
        if (!cancelled) setError(`Could not load your profile: ${String(caught)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const changeAvatar = useCallback(async () => {
    if (!profileClient) return;
    setAvatarWorking(true);
    setError(null);
    try {
      const next = await pickAndUploadAvatar(profileClient);
      if (!next) return;
      await profileClient.setGlobalPersonProfile({
        name: normalizePersonName(savedProfileName) ?? undefined,
        handle: normalizePersonHandle(savedProfileHandle) ?? undefined,
        avatar: next,
      });
      setAvatarUrl(next);
    } catch (caught) {
      setError(`Could not set your picture: ${String(caught)}`);
    } finally {
      setAvatarWorking(false);
    }
  }, [profileClient, savedProfileHandle, savedProfileName]);

  const resetAvatar = useCallback(async () => {
    if (!profileClient) return;
    setAvatarWorking(true);
    setError(null);
    try {
      await profileClient.setGlobalPersonProfile({
        name: normalizePersonName(savedProfileName) ?? undefined,
        handle: normalizePersonHandle(savedProfileHandle) ?? undefined,
        avatar: '',
      });
      setAvatarUrl(undefined);
    } catch (caught) {
      setError(`Could not restore your generated mark: ${String(caught)}`);
    } finally {
      setAvatarWorking(false);
    }
  }, [profileClient, savedProfileHandle, savedProfileName]);

  const saveName = useCallback(async () => {
    if (!profileClient || !profilePubkey) return;
    const normalized = normalizePersonName(profileName);
    const normalizedHandle = normalizePersonHandle(profileHandle);
    const trimmedNip05 = profileNip05.trim();
    const normalizedNip05 = trimmedNip05 ? (normalizeNip05Identifier(trimmedNip05) ?? '') : '';
    if (!normalized) {
      setError('Choose a name between 1 and 60 characters.');
      return;
    }
    if (!normalizedHandle) {
      setError('Choose a handle using 1-30 letters, numbers, dots, dashes, or underscores.');
      return;
    }
    if (trimmedNip05 && !normalizedNip05) {
      setError('Your NIP-05 identifier must look like name@domain.');
      return;
    }
    setNameWorking(true);
    setNameSaved(false);
    setError(null);
    try {
      await profileClient.setGlobalPersonProfile({
        name: normalized,
        handle: normalizedHandle,
        avatar: avatarUrl,
        nip05: normalizedNip05,
      });
      await savePreferredPersonName(profilePubkey, normalized);
      setProfileName(normalized);
      setSavedProfileName(normalized);
      setProfileHandle(normalizedHandle);
      setSavedProfileHandle(normalizedHandle);
      setProfileNip05(normalizedNip05);
      setSavedProfileNip05(normalizedNip05);
      setNameSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (caught) {
      setError(`Could not save your name: ${String(caught)}`);
    } finally {
      setNameWorking(false);
    }
  }, [avatarUrl, profileClient, profileHandle, profileName, profileNip05, profilePubkey]);

  const claimHandle = useCallback(async () => {
    if (!profileClient || !profileIdentity || claimWorking) return;
    const requested = claimName.trim().toLowerCase();
    if (!requested) return;
    setClaimWorking(true);
    setClaimStatus('idle');
    try {
      const result = await claimNip05Handle(
        getBuzzRuntimeConfig().relayUrl,
        profileIdentity,
        requested,
      );
      const identifier = `${result.name}@buzzrouter.com`;
      await profileClient.setGlobalPersonProfile({
        name: normalizePersonName(savedProfileName) ?? undefined,
        handle: normalizePersonHandle(savedProfileHandle) ?? undefined,
        avatar: avatarUrl,
        nip05: identifier,
      });
      setProfileNip05(identifier);
      setSavedProfileNip05(identifier);
      setClaimName('');
      setClaimStatus('claimed');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (caught) {
      if (caught instanceof Nip05ClaimError && caught.code === 'name_taken') {
        setClaimStatus('taken');
      } else if (caught instanceof Nip05ClaimError && caught.code === 'invalid_name') {
        setClaimStatus('invalid');
      } else {
        setClaimStatus('error');
      }
    } finally {
      setClaimWorking(false);
    }
  }, [
    avatarUrl,
    claimName,
    claimWorking,
    profileClient,
    profileIdentity,
    savedProfileHandle,
    savedProfileName,
  ]);

  const togglePush = useCallback(
    async (enabled: boolean) => {
      if (!profileIdentity || pushWorking) return;
      setPushWorking(true);
      setError(null);
      try {
        await setBuzzPushEnabled(profileIdentity, enabled);
        setPushEnabledState(enabled);
        setPushPermission(await getPushPermissionInfo());
      } catch (caught) {
        setError(`Could not update notifications: ${String(caught)}`);
      } finally {
        setPushWorking(false);
      }
    },
    [profileIdentity, pushWorking],
  );

  const lockExport = useCallback(() => {
    setSecret(null);
    setRevealed(false);
    setShowQr(false);
    setCopied(false);
    setTypedConfirmation('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (Platform.OS === 'web') {
        if (!cancelled) setConfirmationMethod('typed');
        return;
      }

      try {
        const [hasHardware, isEnrolled, types] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
          LocalAuthentication.supportedAuthenticationTypesAsync(),
        ]);
        if (cancelled) return;
        if (hasHardware && isEnrolled) {
          setBiometricLabel(
            types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
              ? 'Face ID'
              : 'fingerprint',
          );
          setConfirmationMethod('biometric');
        } else {
          setConfirmationMethod('typed');
        }
      } catch {
        if (!cancelled) setConfirmationMethod('typed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') lockExport();
    });
    return () => subscription.remove();
  }, [lockExport]);

  const loadSecret = useCallback(async () => {
    const storedSecret = await loadBuzzIdentityNsecForExport();
    if (!storedSecret) throw new Error('No identity key is stored on this device.');
    setSecret(storedSecret);
    setRevealed(false);
    setShowQr(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (confirmationMethod === 'checking' || working) return;
    if (confirmationMethod === 'typed' && typedConfirmation.trim() !== TYPED_CONFIRMATION) {
      setError(`Type ${TYPED_CONFIRMATION} exactly to continue.`);
      return;
    }

    setWorking(true);
    setError(null);
    try {
      if (confirmationMethod === 'biometric') {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Export your Beeline identity key',
          promptSubtitle: 'Confirm that it is you',
          cancelLabel: 'Cancel',
          fallbackLabel: 'Use device passcode',
          biometricsSecurityLevel: 'strong',
        });
        if (!result.success) {
          if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
            setError('Authentication did not complete. Your key is still hidden.');
          }
          return;
        }
      }
      await loadSecret();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setError('Beeline could not unlock the identity key on this device.');
      lockExport();
    } finally {
      setWorking(false);
    }
  }, [confirmationMethod, loadSecret, lockExport, typedConfirmation, working]);

  const handleCopy = useCallback(async () => {
    if (!secret) return;
    try {
      await Clipboard.setStringAsync(secret);
      setCopied(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setError('Beeline could not copy the key. You can reveal and copy it manually.');
    }
  }, [secret]);

  const maskedSecret = secret
    ? `${secret.slice(0, 5)}${'•'.repeat(Math.max(8, secret.length - 5))}`
    : '';
  const pushPermissionLabel = pushPermission
    ? pushPermission.status === 'unsupported'
      ? 'Not supported on this device'
      : pushPermission.granted
        ? 'OS permission: allowed'
        : pushPermission.canAskAgain
          ? 'OS permission: not allowed yet'
          : 'OS permission: blocked in device settings'
    : 'Checking OS permission';
  const linkedGoogleLabel =
    linkedGoogle === 'connected'
      ? 'Google account connected'
      : linkedGoogle === 'not-linked'
        ? 'No Google account linked'
        : linkedGoogle === 'unavailable'
          ? 'Google link unavailable while offline'
          : 'Checking linked account';
  const claimStatusLabel =
    claimStatus === 'claimed'
      ? '✓ CLAIMED'
      : claimStatus === 'taken'
        ? 'ALREADY TAKEN'
        : claimStatus === 'invalid'
          ? 'USE 1-30 LOWERCASE LETTERS, NUMBERS, DASHES, OR UNDERSCORES'
          : claimStatus === 'error'
            ? 'COULD NOT CLAIM HANDLE'
            : 'FIRST COME, FIRST SERVED';

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <HullSurface strength="quiet" style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>My Settings</Text>
        </View>
      </HullSurface>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {profilePubkey && (
          <View style={styles.profileSection}>
            <View style={styles.nameSection} testID="identity-person-name-setting">
              <Text style={styles.sectionLabel}>GLOBAL IDENTITY</Text>
              <Text style={styles.heading}>How people see you</Text>
              <Text style={styles.body}>
                Your name, handle, and picture stay the same in every Workspace, Room, and DM.
              </Text>
              <TextInput
                accessibilityLabel="Your display name"
                autoCapitalize="words"
                autoCorrect={false}
                editable={!nameWorking}
                maxLength={60}
                onBlur={() => setNameFocused(false)}
                onChangeText={(value) => {
                  setProfileName(value);
                  setNameSaved(false);
                }}
                onFocus={() => setNameFocused(true)}
                onSubmitEditing={() => void saveName()}
                placeholder="Ada"
                placeholderTextColor={groknight.dim}
                returnKeyType="done"
                style={[styles.nameInput, nameFocused && styles.nameInputFocused]}
                testID="identity-person-name-input"
                value={profileName}
              />
              <View style={[styles.handleInputRow, handleFocused && styles.nameInputFocused]}>
                <Text style={styles.handlePrefix}>@</Text>
                <TextInput
                  accessibilityLabel="Your handle"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!nameWorking}
                  maxLength={30}
                  onBlur={() => setHandleFocused(false)}
                  onChangeText={(value) => {
                    setProfileHandle(value.replace(/^@+/, ''));
                    setNameSaved(false);
                  }}
                  onFocus={() => setHandleFocused(true)}
                  onSubmitEditing={() => void saveName()}
                  placeholder={personHandle(profileName, profilePubkey)}
                  placeholderTextColor={groknight.dim}
                  returnKeyType="done"
                  style={styles.handleInput}
                  testID="identity-person-handle-input"
                  value={profileHandle}
                />
              </View>
              <TextInput
                accessibilityLabel="Your NIP-05 identifier"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!nameWorking}
                keyboardType="email-address"
                maxLength={255}
                onBlur={() => setNip05Focused(false)}
                onChangeText={(value) => {
                  setProfileNip05(value);
                  setNameSaved(false);
                }}
                onFocus={() => setNip05Focused(true)}
                onSubmitEditing={() => void saveName()}
                placeholder="name@your-domain.com (optional)"
                placeholderTextColor={groknight.dim}
                returnKeyType="done"
                style={[styles.nameInput, nip05Focused && styles.nameInputFocused]}
                testID="identity-person-nip05-input"
                value={profileNip05}
              />
              <View style={styles.nameMetaRow}>
                <Text style={styles.nameHandle} testID="identity-person-nip05-status">
                  {savedProfileNip05
                    ? nip05Status === 'verified'
                      ? '✓ NIP-05 VERIFIED'
                      : nip05Status === 'checking'
                        ? 'NIP-05 CHECKING…'
                        : nip05Status === 'mismatch'
                          ? 'NIP-05 DOES NOT MATCH THIS KEY'
                          : 'NIP-05 COULD NOT BE VERIFIED'
                    : 'ONE PROFILE · ALL WORKSPACES'}
                </Text>
                {nameSaved && <Text style={styles.nameSaved}>✓ SAVED</Text>}
              </View>
              <MonoButton
                disabled={
                  nameWorking ||
                  !normalizePersonName(profileName) ||
                  !normalizePersonHandle(profileHandle) ||
                  (profileNip05.trim() !== '' && !normalizeNip05Identifier(profileNip05)) ||
                  (normalizePersonName(profileName) === savedProfileName &&
                    normalizePersonHandle(profileHandle) === savedProfileHandle &&
                    (normalizeNip05Identifier(profileNip05) ?? '') === savedProfileNip05)
                }
                label="Save identity"
                loading={nameWorking}
                onPress={() => void saveName()}
                style={styles.nameButton}
              />
            </View>
            <View style={styles.avatarSection}>
              <IdentityMark
                kind="human"
                seed={profilePubkey}
                avatarUrl={avatarUrl}
                name={profileName || 'You'}
                size={76}
              />
              <View style={styles.avatarCopy}>
                <Text style={styles.heading}>Your picture</Text>
                <Text style={styles.body}>
                  Cosmetic only. Your generated person mark returns if the image is removed.
                </Text>
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    disabled={avatarWorking}
                    onPress={() => void changeAvatar()}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {avatarWorking ? 'Working…' : avatarUrl ? 'Change picture' : 'Set picture'}
                    </Text>
                  </TouchableOpacity>
                  {avatarUrl && (
                    <TouchableOpacity
                      style={styles.secondaryButton}
                      disabled={avatarWorking}
                      onPress={() => void resetAvatar()}
                    >
                      <Text style={styles.secondaryButtonText}>Use generated mark</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          </View>
        )}
        <View style={styles.settingsSection} testID="claim-handle-setting">
          <Text style={styles.sectionLabel}>BEELINE HANDLE</Text>
          <Text style={styles.body}>Claim a free handle at buzzrouter.com, first come first served.</Text>
          <View style={styles.claimRow}>
            <TextInput
              accessibilityLabel="Desired Beeline handle"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!claimWorking}
              maxLength={30}
              onChangeText={(value) => {
                setClaimName(value);
                setClaimStatus('idle');
              }}
              onSubmitEditing={() => void claimHandle()}
              placeholder="yourname"
              placeholderTextColor={groknight.dim}
              returnKeyType="done"
              style={styles.claimInput}
              testID="identity-claim-handle-input"
              value={claimName}
            />
            <Text style={styles.claimSuffix}>@buzzrouter.com</Text>
          </View>
          <View style={styles.nameMetaRow}>
            <Text style={styles.nameHandle} testID="identity-claim-handle-status">
              {claimStatusLabel}
            </Text>
          </View>
          <MonoButton
            disabled={claimWorking || !claimName.trim()}
            label="Claim handle"
            loading={claimWorking}
            onPress={() => void claimHandle()}
            style={styles.nameButton}
            testID="identity-claim-handle-button"
          />
        </View>

        <View style={styles.settingsSection} testID="notifications-setting">
          <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
          <View style={styles.settingLine}>
            <View style={styles.settingCopy}>
              <Text style={styles.settingTitle}>Push notifications</Text>
              <Text style={styles.settingSubtitle}>{pushPermissionLabel}</Text>
            </View>
            <Switch
              accessibilityLabel="Push notifications"
              disabled={pushEnabled === null || pushWorking}
              onValueChange={(enabled) => void togglePush(enabled)}
              testID="push-notifications-toggle"
              thumbColor={groknight.textPrimary}
              trackColor={{ false: groknight.bgRaised, true: groknight.chrome }}
              value={pushEnabled ?? false}
            />
          </View>
        </View>

        <View style={styles.settingsSection} testID="linked-sign-in-setting">
          <Text style={styles.sectionLabel}>LINKED SIGN-IN</Text>
          <View style={styles.settingLine}>
            <View style={styles.linkedGlyph}>
              <Text style={styles.linkedGlyphText}>G</Text>
            </View>
            <View style={styles.settingCopy}>
              <Text style={styles.settingTitle}>Google</Text>
              <Text style={styles.settingSubtitle}>{linkedGoogleLabel}</Text>
            </View>
            <Text style={styles.linkedState}>{linkedGoogle === 'connected' ? '✓' : '·'}</Text>
          </View>
        </View>

        <View style={styles.intro}>
          <Text style={styles.sectionLabel}>KEY BACKUP</Text>
          <Text style={styles.heading}>Export your key</Text>
          <Text style={styles.body}>Save a copy so you can recover your Beeline identity.</Text>
        </View>

        <View style={styles.warning}>
          <Text style={styles.warningGlyph}>!</Text>
          <Text style={styles.warningText}>
            Anyone with this key controls your identity. Export it only to a trusted app.
          </Text>
        </View>

        {!secret ? (
          <View style={styles.confirmSection}>
            <Text style={styles.sectionLabel}>Confirm it&apos;s you</Text>
            {confirmationMethod === 'typed' && (
              <>
                <Text style={styles.confirmHint}>
                  Type {TYPED_CONFIRMATION} to unlock the key on this device.
                </Text>
                <TextInput
                  accessibilityLabel={`Type ${TYPED_CONFIRMATION} to confirm`}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!working}
                  onChangeText={setTypedConfirmation}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  onSubmitEditing={() => void handleConfirm()}
                  placeholder={TYPED_CONFIRMATION}
                  placeholderTextColor={groknight.dim}
                  style={[styles.confirmInput, inputFocused && styles.confirmInputFocused]}
                  value={typedConfirmation}
                />
              </>
            )}
            <MonoButton
              label={
                confirmationMethod === 'checking'
                  ? 'Checking device security'
                  : working
                    ? 'Confirming'
                    : confirmationMethod === 'biometric'
                      ? `Confirm with ${biometricLabel}`
                      : 'Confirm export'
              }
              loading={working || confirmationMethod === 'checking'}
              disabled={confirmationMethod === 'checking' || working}
              onPress={() => void handleConfirm()}
              style={styles.primaryButton}
            />
          </View>
        ) : (
          <View style={styles.exportSection}>
            <View style={styles.exportHeadingRow}>
              <Text style={styles.sectionLabel}>Nostr secret key</Text>
              <Text style={styles.unlockedLabel}>Unlocked</Text>
            </View>
            <HullSurface strength="code" style={styles.secretBox}>
              <Text selectable={revealed} style={styles.secretText}>
                {revealed ? secret : maskedSecret}
              </Text>
            </HullSurface>
            <View style={styles.actions}>
              <TouchableOpacity
                accessibilityLabel={revealed ? 'Hide secret key' : 'Reveal secret key'}
                onPress={() => setRevealed((value) => !value)}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>{revealed ? 'Hide' : 'Reveal'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => void handleCopy()} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>{copied ? '✓ COPIED' : 'Copy'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityState={{ expanded: showQr }}
                onPress={() => setShowQr((value) => !value)}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>{showQr ? 'Hide QR' : 'Show QR'}</Text>
              </TouchableOpacity>
            </View>

            {showQr && (
              <PixelGateReveal style={styles.qrSection}>
                <QrCode value={secret} />
                <Text style={styles.qrHint}>Scan only with a Nostr signer you trust.</Text>
              </PixelGateReveal>
            )}

            <TouchableOpacity onPress={lockExport} style={styles.lockButton}>
              <Text style={styles.lockButtonText}>Lock this screen</Text>
            </TouchableOpacity>
          </View>
        )}

        {error && (
          <View accessibilityRole="alert" style={styles.errorPanel}>
            <Text style={styles.errorLabel}>! ERROR</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Text style={styles.footer}>Copy and QR stay on this device.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 66,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  backButton: {
    width: 44,
    height: 44,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    ...Typography.default(),
    color: groknight.chrome,
    fontSize: 31,
    lineHeight: 34,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  content: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 36 },
  profileSection: {
    paddingBottom: 24,
    marginBottom: 28,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  nameSection: { marginBottom: 28 },
  avatarSection: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  avatarCopy: { flex: 1, minWidth: 0 },
  intro: { maxWidth: 560 },
  sectionLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  heading: {
    ...Typography.default('semiBold'),
    marginTop: 7,
    color: groknight.textPrimary,
    fontSize: 24,
  },
  body: {
    ...Typography.default(),
    marginTop: 9,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  nameInput: {
    ...Typography.default('semiBold'),
    minHeight: 48,
    marginTop: 16,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 17,
  },
  nameInputFocused: { borderWidth: 2, borderColor: groknight.focus, paddingHorizontal: 11 },
  handleInputRow: {
    minHeight: 48,
    marginTop: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    backgroundColor: groknight.bgBase,
  },
  handlePrefix: {
    ...Typography.mono('semiBold'),
    marginRight: 2,
    color: groknight.textMuted,
    fontSize: 15,
  },
  handleInput: {
    ...Typography.mono('semiBold'),
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    color: groknight.textPrimary,
    fontSize: 15,
  },
  nameMetaRow: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  nameHandle: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  nameSaved: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 10,
    letterSpacing: 0.7,
  },
  nameButton: { marginTop: 8 },
  claimRow: {
    minHeight: 48,
    marginTop: 16,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    backgroundColor: groknight.bgBase,
  },
  claimInput: {
    ...Typography.mono('semiBold'),
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    color: groknight.textPrimary,
    fontSize: 15,
  },
  claimSuffix: {
    ...Typography.mono('semiBold'),
    marginLeft: 2,
    color: groknight.textMuted,
    fontSize: 15,
  },
  settingsSection: {
    paddingBottom: 24,
    marginBottom: 28,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  settingLine: {
    minHeight: 68,
    marginTop: 9,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  settingCopy: { flex: 1, minWidth: 0, paddingVertical: 12 },
  settingTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 14,
  },
  settingSubtitle: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  linkedGlyph: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  linkedGlyphText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 13,
  },
  linkedState: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 13,
  },
  warning: {
    marginTop: 24,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  warningGlyph: {
    ...Typography.default('semiBold'),
    width: 22,
    height: 22,
    borderWidth: 1,
    borderColor: groknight.chrome,
    color: groknight.chrome,
    lineHeight: 20,
    textAlign: 'center',
  },
  warningText: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.chrome,
    fontSize: 14,
    lineHeight: 20,
  },
  confirmSection: { marginTop: 28 },
  confirmHint: {
    ...Typography.default(),
    marginTop: 9,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  confirmInput: {
    ...Typography.default(),
    minHeight: 44,
    marginTop: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 14,
    letterSpacing: 1.2,
  },
  confirmInputFocused: { borderWidth: 2, borderColor: groknight.focus, paddingHorizontal: 11 },
  primaryButton: {
    marginTop: 14,
  },
  exportSection: { marginTop: 28 },
  exportHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  unlockedLabel: {
    ...Typography.default('semiBold'),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  secretBox: {
    minHeight: 74,
    marginTop: 9,
    padding: 13,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 3,
    backgroundColor: groknight.bgBase,
  },
  secretText: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 19,
  },
  actions: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 12,
  },
  qrSection: { marginTop: 22, alignItems: 'center' },
  qrFrame: {
    width: 248,
    height: 248,
    maxWidth: '100%',
    padding: 8,
    borderRadius: 3,
    backgroundColor: groknight.textPrimary,
  },
  qrHint: {
    ...Typography.default(),
    maxWidth: 320,
    marginTop: 12,
    color: groknight.muted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  lockButton: {
    minHeight: 44,
    marginTop: 22,
    alignSelf: 'center',
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  lockButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 11,
  },
  errorPanel: {
    marginTop: 16,
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
  footer: {
    ...Typography.default(),
    marginTop: 28,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
