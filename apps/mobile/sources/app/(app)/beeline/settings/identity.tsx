import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getRandomBytes } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as Updates from 'expo-updates';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  buildOidcBindEvent,
  finishOidcBind,
  fallbackPersonName,
  lookupRecovery,
  lookupManagedIdentity,
  normalizePersonHandle,
  normalizePersonName,
  personHandle,
  startGitHubBind,
  type BuzzClient,
  type Identity,
  type ManagedIdentity,
} from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import {
  getEffectiveRelayUrl,
  clearBuzzIdentity,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId } from '@/buzz/community-storage';
import {
  ensurePersonNameForWorkspace,
  loadPreferredPersonName,
  savePreferredPersonName,
} from '@/buzz/person-name';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { Typography } from '@/constants/Typography';
import { HullSurface, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import {
  getBuzzPushEnabled,
  getBuzzPushRegistrationState,
  registerBuzzPushNotifications,
  setBuzzPushEnabled,
  type BuzzPushRegistrationResult,
  type BuzzPushRegistrationState,
} from '@/push/buzz-push-registration';
import { buzzPushPhaseDetail, pushSwitchValue } from '@/push/buzz-push-status';
import { getPushPermissionInfo, type PushPermissionInfo } from '@/sync/pushRegistration';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { FacePickerSheet } from '@/components/buzz/FacePickerSheet';
import { defaultFaceForSeed } from '@/buzz/faces';
import { authSessionOptions } from '@/auth/auth-session';
import {
  clearPendingGitHubSignInState,
  cancelPendingGitHubSignIn,
  githubSignInRedirectUri,
  persistGitHubSignInState,
  resumeGitHubSignInCallback,
  runResilientGitHubSignInSession,
} from '@/auth/github-auth-session';
import { GitHubAccountMismatchError, monolithSession } from '@/auth/monolith-session';
import { markSignInInFlight, waitForAuthCallback } from '@/auth/onboarding-state';
import { t } from '@/text';
import { clearMobileSurfaceStorage } from '@/buzz/surface-storage';
import { loadAppConfig } from '@/sync/appConfig';
import {
  createManualUpdateState,
  isManualUpdateBusy,
  manualUpdateButtonLabel,
  manualUpdateMessage,
  manualUpdateReducer,
} from './manual-update-state';

function randomState(): string {
  return btoa(String.fromCharCode(...getRandomBytes(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export default function BuzzIdentitySettings() {
  const { githubReconnect } = useLocalSearchParams<{ githubReconnect?: string }>();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [profileClient, setProfileClient] = useState<BuzzClient | null>(null);
  const [profileIdentity, setProfileIdentity] = useState<Identity | null>(null);
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [profileName, setProfileName] = useState('');
  const [savedProfileName, setSavedProfileName] = useState('');
  const [profileHandle, setProfileHandle] = useState('');
  const [savedProfileHandle, setSavedProfileHandle] = useState('');
  const [nameWorking, setNameWorking] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [pushEnabled, setPushEnabledState] = useState<boolean | null>(null);
  const [pushRegistration, setPushRegistration] = useState<BuzzPushRegistrationState | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
  const [pushWorking, setPushWorking] = useState(false);
  const [linkedAccount, setLinkedAccount] = useState<
    'checking' | 'connected' | 'not-linked' | 'unavailable'
  >('checking');
  const [managedIdentity, setManagedIdentity] = useState<ManagedIdentity | null>(null);
  const [face, setFace] = useState<string | null>(null);
  const [facePickerOpen, setFacePickerOpen] = useState(false);
  const [githubWorking, setGitHubWorking] = useState(false);
  const [githubNotice, setGitHubNotice] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const manualUpdateRunning = useRef(false);
  const [manualUpdate, dispatchManualUpdate] = useReducer(
    manualUpdateReducer,
    Updates.isEnabled,
    createManualUpdateState,
  );
  const manualUpdateBusy = isManualUpdateBusy(manualUpdate);
  const release = loadAppConfig();
  const releaseValue = `${release.releaseVersion ?? 'development'}${
    release.releaseSha ? ` · ${release.releaseSha.slice(0, 12)}` : ''
  }`;
  useEffect(() => {
    if (githubReconnect === 'success') setGitHubNotice('GitHub reconnected.');
    else if (githubReconnect === 'mismatch')
      setGitHubNotice('Reconnect the GitHub account already linked to this identity.');
    else if (githubReconnect === 'failed')
      setGitHubNotice('Could not reconnect GitHub. Try again.');
  }, [githubReconnect]);
  const monolithEnabled = getBuzzRuntimeConfig().monolithEnabled;

  const signOut = useCallback(async () => {
    if (!confirmSignOut) {
      setConfirmSignOut(true);
      return;
    }
    await Promise.all([
      monolithSession.clear(),
      clearBuzzIdentity(),
      clearPendingGitHubSignInState(),
    ]);
    clearMobileSurfaceStorage();
    router.replace('/beeline/onboarding');
  }, [confirmSignOut]);

  const deleteAccount = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      const identity = profileIdentity ?? (await loadBuzzIdentity());
      if (!identity) throw new Error('identity unavailable');
      await new BuzzRigTransport(identity).deleteAccount();
      await Promise.all([
        monolithSession.clear(),
        clearBuzzIdentity(),
        clearPendingGitHubSignInState(),
      ]);
      clearMobileSurfaceStorage();
      router.replace('/beeline/onboarding');
    } catch {
      setError('Could not delete the account. Check your connection and try again.');
      setDeleteBusy(false);
    }
  }, [confirmDelete, deleteBusy, profileIdentity]);

  const checkForUpdate = useCallback(async () => {
    if (!Updates.isEnabled || manualUpdateRunning.current) return;
    manualUpdateRunning.current = true;
    dispatchManualUpdate({ type: 'start-check' });
    try {
      const update = await Updates.checkForUpdateAsync();
      if (!update.isAvailable) {
        dispatchManualUpdate({ type: 'latest' });
        return;
      }
      dispatchManualUpdate({ type: 'update-available' });
      const fetched = await Updates.fetchUpdateAsync();
      if (!fetched.isNew && !fetched.isRollBackToEmbedded) throw new Error('download failed');
      dispatchManualUpdate({ type: 'update-downloaded' });
      await Updates.reloadAsync();
    } catch {
      dispatchManualUpdate({ type: 'failed' });
    } finally {
      manualUpdateRunning.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) return;
        const relayUrl = await getEffectiveRelayUrl();
        const transport = new BuzzRigTransport(identity);
        const client = await transport.ensureClient();
        const [workspaceList, activeCommunityId, preferredName, enabled, registration, permission] =
          await Promise.all([
            new RoomViewClient({ baseUrl: relayUrl, identity }).workspaces(),
            loadActiveCommunityId(identity.publicKey),
            loadPreferredPersonName(identity.publicKey),
            getBuzzPushEnabled(identity.publicKey),
            getBuzzPushRegistrationState(identity.publicKey),
            getPushPermissionInfo(),
          ]);
        const communityId = workspaceList.workspaces.some((item) => item.id === activeCommunityId)
          ? (activeCommunityId ?? undefined)
          : workspaceList.workspaces[0]?.id;
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
          setPushEnabledState(enabled);
          setPushRegistration(registration);
          setPushPermission(permission);
        }
        try {
          if (monolithEnabled) {
            const hosted = await monolithPhoneOperation('getManagedIdentity', {});
            if (!cancelled) {
              setFace(hosted.face ?? null);
              setManagedIdentity(
                hosted.handle
                  ? {
                      handle: hosted.handle,
                      displayName: hosted.name,
                      source: 'github',
                      githubLogin: hosted.handle,
                      githubRenameAvailable: false,
                    }
                  : null,
              );
              setLinkedAccount('connected');
            }
            return;
          }
          const [links, hostedIdentity] = await Promise.all([
            lookupRecovery(getBuzzRuntimeConfig().relayUrl, identity),
            lookupManagedIdentity(getBuzzRuntimeConfig().relayUrl, identity),
          ]);
          const linked = links.some((link) => link.provider === 'https://github.com');
          if (!cancelled) {
            setManagedIdentity(hostedIdentity);
            if (hostedIdentity) {
              setProfileName(hostedIdentity.displayName);
              setSavedProfileName(hostedIdentity.displayName);
              setProfileHandle(hostedIdentity.handle);
              setSavedProfileHandle(hostedIdentity.handle);
            }
            setLinkedAccount(linked ? 'connected' : 'not-linked');
          }
        } catch {
          if (!cancelled) setLinkedAccount('unavailable');
        }
      } catch (caught) {
        if (!cancelled) setError(`Could not load your profile: ${String(caught)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monolithEnabled]);

  const saveName = useCallback(async () => {
    if (!profileClient || !profilePubkey) return;
    const normalized = normalizePersonName(profileName);
    const normalizedHandle = normalizePersonHandle(managedIdentity?.handle ?? profileHandle);
    if (!normalized) {
      setError('Choose a name between 1 and 60 characters.');
      return;
    }
    if (!normalizedHandle) {
      setError('Choose a handle using 1-30 letters, numbers, dots, dashes, or underscores.');
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
      });
      await savePreferredPersonName(profilePubkey, normalized);
      setProfileName(normalized);
      setSavedProfileName(normalized);
      setProfileHandle(normalizedHandle);
      setSavedProfileHandle(normalizedHandle);
      setNameSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (caught) {
      setError(`Could not save your name: ${String(caught)}`);
    } finally {
      setNameWorking(false);
    }
  }, [avatarUrl, managedIdentity, profileClient, profileHandle, profileName, profilePubkey]);

  const applyHostedIdentity = useCallback(
    async (hosted: ManagedIdentity) => {
      if (!profileClient || !profilePubkey) return;
      const nextName = hosted.displayName;
      await profileClient.setGlobalPersonProfile({
        name: nextName,
        handle: hosted.handle,
        avatar: avatarUrl,
      });
      await savePreferredPersonName(profilePubkey, nextName);
      setProfileName(nextName);
      setSavedProfileName(nextName);
      setProfileHandle(hosted.handle);
      setSavedProfileHandle(hosted.handle);
      setManagedIdentity(hosted);
    },
    [avatarUrl, profileClient, profilePubkey],
  );

  const connectGitHub = useCallback(async () => {
    if (!profileIdentity || githubWorking || Platform.OS === 'web') return;
    setGitHubWorking(true);
    setGitHubNotice(null);
    setError(null);
    markSignInInFlight(true);
    try {
      const state = randomState();
      const redirectUri = githubSignInRedirectUri();
      const monolith = getBuzzRuntimeConfig().monolithEnabled;
      const challenge = monolith
        ? await runResilientGitHubSignInSession({
            state,
            recoveryToken: randomState(),
            purpose: 'reconnect',
            openAuthSession: (authorizationUrl, callbackUri) =>
              WebBrowser.openAuthSessionAsync(
                authorizationUrl,
                callbackUri,
                authSessionOptions(Platform.OS, callbackUri),
              ),
            subscribeToUrls: (listener) =>
              Linking.addEventListener('url', ({ url }) => listener(url)),
          })
        : await (async () => {
            const start = startGitHubBind(getBuzzRuntimeConfig().relayUrl, {
              redirectUri,
              state,
            });
            await persistGitHubSignInState(state);
            const callbackUrl = await waitForAuthCallback({
              redirectUri: start.redirectUri,
              openAuthSession: () =>
                WebBrowser.openAuthSessionAsync(
                  start.authorizationUrl,
                  start.redirectUri,
                  authSessionOptions(Platform.OS, start.redirectUri),
                ),
              subscribeToUrls: (listener) =>
                Linking.addEventListener('url', ({ url }) => listener(url)),
            });
            return resumeGitHubSignInCallback(callbackUrl);
          })();
      if (monolith) {
        await monolithSession.reconnectGitHubTicket(challenge.ticket);
        await clearPendingGitHubSignInState();
        setGitHubNotice('GitHub reconnected.');
        router.replace({
          pathname: '/beeline/settings',
          params: { githubReconnect: 'success' },
        });
        return;
      }
      const event = buildOidcBindEvent(challenge, profileIdentity);
      const result = await finishOidcBind(getBuzzRuntimeConfig().relayUrl, challenge, event);
      await clearPendingGitHubSignInState();
      const hosted =
        result.identity ??
        (await lookupManagedIdentity(getBuzzRuntimeConfig().relayUrl, profileIdentity));
      if (hosted) await applyHostedIdentity(hosted);
      setLinkedAccount('connected');
      setGitHubNotice(t('beelineIdentity.githubLinkedNotice'));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (caught) {
      if (getBuzzRuntimeConfig().monolithEnabled) {
        await cancelPendingGitHubSignIn().catch(() => undefined);
        router.replace({
          pathname: '/beeline/settings',
          params: {
            githubReconnect: caught instanceof GitHubAccountMismatchError ? 'mismatch' : 'failed',
          },
        });
        return;
      }
      await clearPendingGitHubSignInState().catch(() => undefined);
      setError(
        `Could not link GitHub: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    } finally {
      markSignInInFlight(false);
      setGitHubWorking(false);
    }
  }, [applyHostedIdentity, githubWorking, profileIdentity]);

  const applyPushResult = useCallback(
    async (
      identity: Identity,
      result: BuzzPushRegistrationResult,
      previous: BuzzPushRegistrationState | null,
    ) => {
      setPushRegistration({
        ...result,
        failedAttempts: result.registered
          ? 0
          : (previous?.failedAttempts ?? 0) + (result.retryable ? 1 : 0),
        updatedAt: Date.now(),
      });
      setPushEnabledState(await getBuzzPushEnabled(identity.publicKey));
      setPushPermission(await getPushPermissionInfo());
    },
    [],
  );

  const togglePush = useCallback(
    async (enabled: boolean) => {
      if (!profileIdentity || pushWorking) return;
      setPushWorking(true);
      setError(null);
      try {
        // The switch reflects the REGISTRATION result, not merely the value
        // the user requested — a failed token acquisition or POST leaves it
        // visibly off with the failure named below.
        const result = await setBuzzPushEnabled(profileIdentity, enabled);
        await applyPushResult(profileIdentity, result, pushRegistration);
      } catch (caught) {
        setError(`Could not update notifications: ${String(caught)}`);
      } finally {
        setPushWorking(false);
      }
    },
    [applyPushResult, profileIdentity, pushRegistration, pushWorking],
  );

  const retryPushRegistration = useCallback(async () => {
    if (!profileIdentity || pushWorking) return;
    setPushWorking(true);
    setError(null);
    try {
      const result = await registerBuzzPushNotifications(profileIdentity);
      await applyPushResult(profileIdentity, result, pushRegistration);
    } catch (caught) {
      setError(`Could not retry push registration: ${String(caught)}`);
    } finally {
      setPushWorking(false);
    }
  }, [applyPushResult, profileIdentity, pushRegistration, pushWorking]);

  const pushRegistrationFailed =
    pushEnabled === true &&
    pushRegistration !== null &&
    !pushRegistration.registered &&
    buzzPushPhaseDetail(pushRegistration.phase) !== null;
  const linkedAccountLabel =
    linkedAccount === 'connected'
      ? 'GitHub account connected'
      : linkedAccount === 'not-linked'
        ? 'No GitHub account linked'
        : linkedAccount === 'unavailable'
          ? 'GitHub link unavailable while offline'
          : 'Checking linked account';
  const managedHandle = managedIdentity?.handle ?? profileHandle;
  const managedHandleLabel = managedHandle ? `@${managedHandle}` : '';
  const pushSupported = pushPermission !== null && pushPermission.status !== 'unsupported';
  const pushOn = pushSwitchValue(pushEnabled, pushRegistration);
  const githubCanLink = linkedAccount === 'not-linked' && Platform.OS !== 'web';

  const commitName = () => {
    if (normalizePersonName(profileName) === savedProfileName) return;
    void saveName();
  };

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
          <Text style={styles.title}>Settings</Text>
        </View>
      </HullSurface>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {profilePubkey && (
          <View style={styles.section} testID="identity-settings">
            <Text style={styles.sectionLabel}>Identity</Text>
            <View style={styles.row} testID="identity-person-name-setting">
              <Text style={styles.rowTitle}>Name</Text>
              <TextInput
                accessibilityLabel="Your display name"
                autoCapitalize="words"
                autoCorrect={false}
                blurOnSubmit
                editable={!nameWorking}
                maxLength={60}
                onBlur={() => {
                  setNameFocused(false);
                  commitName();
                }}
                onChangeText={(value) => {
                  setProfileName(value);
                  setNameSaved(false);
                }}
                onFocus={() => setNameFocused(true)}
                onSubmitEditing={commitName}
                placeholder="Ada"
                placeholderTextColor={theme.buzz.dim}
                returnKeyType="done"
                style={[styles.inlineInput, nameFocused && styles.inlineInputFocused]}
                testID="identity-person-name-input"
                value={profileName}
              />
            </View>
            <View style={styles.row} testID="identity-managed-handle">
              <Text style={styles.rowTitle}>Handle</Text>
              <Text numberOfLines={1} style={styles.monoValue}>
                {managedHandleLabel || '—'}
              </Text>
            </View>
            {monolithEnabled && (
              <TouchableOpacity
                accessibilityLabel="Change face"
                accessibilityRole="button"
                onPress={() => setFacePickerOpen(true)}
                style={styles.row}
                testID="identity-face-setting"
              >
                <IdentityMark
                  kind="human"
                  seed={profilePubkey}
                  face={face ?? defaultFaceForSeed(profilePubkey)}
                  name={profileName || 'You'}
                  size={38}
                  testID="identity-face-mark"
                />
                <Text style={styles.rowTitle}>Face</Text>
                <Text style={styles.chevron}>›</Text>
                <FacePickerSheet
                  face={face}
                  onClose={() => setFacePickerOpen(false)}
                  onFaceChange={setFace}
                  onSave={(next) => monolithPhoneOperation('updateIdentityFace', { faceId: next })}
                  seed={profilePubkey}
                  visible={facePickerOpen}
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {pushSupported ? (
          <View style={styles.section} testID="notifications-section">
            <Text style={styles.sectionLabel}>Notifications</Text>
            <View style={styles.row} testID="notifications-setting">
              <Text style={styles.rowTitle}>Push notifications</Text>
              <Switch
                accessibilityLabel="Push notifications"
                disabled={pushEnabled === null || pushWorking}
                onValueChange={(enabled) => void togglePush(enabled)}
                testID="push-notifications-toggle"
                thumbColor={theme.buzz.textPrimary}
                trackColor={{ false: theme.buzz.bgRaised, true: theme.buzz.chrome }}
                value={pushOn}
              />
            </View>
            {pushRegistrationFailed ? (
              <TouchableOpacity
                disabled={pushWorking}
                onPress={() => void retryPushRegistration()}
                style={styles.pushRetryButton}
                testID="push-retry-registration"
              >
                <Text style={styles.pushRetryText}>{pushWorking ? 'RETRYING…' : 'RETRY NOW'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <View style={styles.section} testID="linked-sign-in-section">
          <Text style={styles.sectionLabel}>Linked sign-in</Text>
          <TouchableOpacity
            accessibilityLabel={`GitHub. ${linkedAccountLabel}`}
            accessibilityRole="button"
            disabled={!githubCanLink || githubWorking}
            onPress={() => void connectGitHub()}
            style={styles.row}
            testID="linked-sign-in-setting"
          >
            <View style={styles.githubMark}>
              <Text style={styles.linkedGlyphText}>GH</Text>
            </View>
            <Text style={styles.rowTitle}>GitHub</Text>
            <Text style={styles.stateMark}>{linkedAccount === 'connected' ? '✓' : '·'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section} testID="account-settings">
          <Text style={styles.sectionLabel}>Device &amp; account</Text>
          <TouchableOpacity
            accessibilityLabel={manualUpdateButtonLabel(manualUpdate)}
            disabled={!Updates.isEnabled || manualUpdateBusy}
            onPress={() => void checkForUpdate()}
            style={[styles.row, (!Updates.isEnabled || manualUpdateBusy) && styles.disabled]}
            testID="ota-update-info"
          >
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>Version</Text>
              <Text numberOfLines={1} style={styles.rowMeta}>
                {[releaseValue, manualUpdateMessage(manualUpdate)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            {manualUpdateBusy ? (
              <View testID="ota-update-progress">
                <PixelLoader compact />
              </View>
            ) : (
              <Text style={styles.actionMark} testID="ota-update-check">
                Check
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel={confirmSignOut ? 'Confirm sign out' : 'Sign out on this device'}
            onPress={() => void signOut()}
            style={styles.row}
            testID="sign-out-setting"
          >
            <Text style={styles.rowTitle}>Sign out</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel={confirmDelete ? 'Confirm delete account' : 'Delete account'}
            disabled={deleteBusy}
            onPress={() => void deleteAccount()}
            style={[styles.row, deleteBusy && styles.disabled]}
            testID="delete-account-setting"
          >
            <Text style={styles.dangerTitle}>{deleteBusy ? 'Deleting…' : 'Delete account'}</Text>
          </TouchableOpacity>
        </View>

        {nameSaved ? <Text style={styles.savedMark}>✓ Saved</Text> : null}
        {githubNotice ? <Text style={styles.notice}>{githubNotice}</Text> : null}

        {confirmSignOut ? (
          <PixelGateReveal style={styles.warning}>
            <Text style={styles.warningText}>Remove this identity from this device?</Text>
            <TouchableOpacity onPress={() => setConfirmSignOut(false)} style={styles.cancelAction}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </PixelGateReveal>
        ) : null}

        {confirmDelete ? (
          <PixelGateReveal style={styles.warning}>
            <Text style={styles.warningText}>
              Permanently delete this account? Shared messages remain attributed to “Deleted
              account”.
            </Text>
            <TouchableOpacity onPress={() => setConfirmDelete(false)} style={styles.cancelAction}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </PixelGateReveal>
        ) : null}

        {error ? (
          <View accessibilityRole="alert" style={styles.errorPanel}>
            <Text style={styles.errorLabel}>! ERROR</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    header: {
      minHeight: 66,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backButtonText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    headerCopy: { flex: 1, minWidth: 0 },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    content: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    section: {},
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    row: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: { ...Typography.default(), ...hull.type.body, flex: 1, color: hull.textPrimary },
    rowMeta: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    monoValue: {
      ...Typography.mono(),
      ...hull.type.body,
      flex: 1,
      color: hull.textSecondary,
      textAlign: 'right',
    },
    inlineInput: {
      ...Typography.default(),
      ...hull.type.body,
      flex: 1,
      minWidth: 0,
      paddingVertical: hull.space.sm,
      color: hull.textPrimary,
      textAlign: 'right',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: 'transparent',
    },
    inlineInputFocused: { borderBottomColor: hull.focus },
    chevron: {
      ...Typography.default(),
      ...hull.type.hero,
      width: 16,
      textAlign: 'right',
      color: hull.textMuted,
    },
    githubMark: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
    },
    linkedGlyphText: {
      ...Typography.mono('semiBold'),
      ...hull.type.meta,
      color: hull.textSecondary,
    },
    stateMark: { ...Typography.mono('semiBold'), ...hull.type.body, color: hull.accent },
    actionMark: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    dangerTitle: { ...Typography.default(), ...hull.type.body, color: hull.dialogDanger },
    disabled: { opacity: 0.42 },
    pushRetryButton: {
      minHeight: 44,
      paddingHorizontal: hull.space.sm,
      justifyContent: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    pushRetryText: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    savedMark: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    notice: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    warning: {
      padding: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
    },
    warningText: { ...Typography.default(), ...hull.type.meta, flex: 1, color: hull.textSecondary },
    cancelAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: hull.space.sm },
    cancelText: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    errorPanel: {
      padding: hull.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
    },
    errorLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.danger },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
  };
});
