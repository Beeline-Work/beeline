import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Updates from 'expo-updates';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  fallbackPersonName,
  lookupManagedIdentity,
  personHandle,
  type Identity,
  type ManagedIdentity,
} from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';
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
import { connectionsForViewer } from '@/buzz/workbench';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { Typography } from '@/constants/Typography';
import { HullSurface, PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
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
import { PushLevelSetting } from '@/components/buzz/PushLevelSetting';
import { AppearanceSetting } from '@/components/buzz/AppearanceSetting';
import { UiSizeSetting } from '@/components/buzz/UiSizeSetting';
import { setAppDisplay } from '@/unistyles';
import { useLocalSettingMutable } from '@/sync/storage';
import { defaultFaceForSeed } from '@/buzz/faces';
import { clearPendingGitHubSignInState } from '@/auth/github-auth-session';
import { monolithSession } from '@/auth/monolith-session';
import { t } from '@/text';
import { clearMobileSurfaceStorage } from '@/buzz/surface-storage';
import { saveStoredPushLevel } from '@/push/push-level-storage';
import { reconcilePresentedNotificationBadge } from '@/push/presented-notifications';
import { loadAppConfig } from '@/sync/appConfig';
import { openExternalUrl } from '@/utils/open-external-url';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import {
  createManualUpdateState,
  isManualUpdateBusy,
  manualUpdateButtonLabel,
  manualUpdateMessage,
  manualUpdateReducer,
} from './manual-update-state';

const PRIVACY_URL = 'https://usebeeline.app/privacy/';
const TERMS_URL = 'https://usebeeline.app/terms/';
const FEEDBACK_MAILTO = 'mailto:hello@usebeeline.app';
const IDENTITY_TILE = 76;
const IDENTITY_TILE_RADIUS = 20;
const IDENTITY_MARK = 64;

export default function BuzzIdentitySettings() {
  const { githubReconnect } = useLocalSearchParams<{ githubReconnect?: string }>();
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [profileIdentity, setProfileIdentity] = useState<Identity | null>(null);
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [pushEnabled, setPushEnabledState] = useState<boolean | null>(null);
  const [pushRegistration, setPushRegistration] = useState<BuzzPushRegistrationState | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
  const [pushWorking, setPushWorking] = useState(false);
  const [pushLevel, setPushLevel] = useState<PushLevel>('mine');
  const [managedIdentity, setManagedIdentity] = useState<ManagedIdentity | null>(null);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [face, setFace] = useState<string | null>(null);
  const [facePickerOpen, setFacePickerOpen] = useState(false);
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
          setProfileIdentity(identity);
          setProfilePubkey(identity.publicKey);
          const nextName = profile?.name ?? preferredName ?? fallbackPersonName(identity.publicKey);
          setProfileName(nextName);
        if (profile?.handle) {
          const handle = profile.handle;
          setManagedIdentity((current) =>
            current ?? {
              handle,
              displayName: nextName,
              source: 'github',
              githubLogin: handle,
              githubRenameAvailable: false,
            },
          );
        }
          setPushEnabledState(enabled);
          setPushRegistration(registration);
          setPushPermission(permission);
        }
        try {
          if (communityId) {
            const view = await getWorkbenchSource().readWorkbench({
              workspaceId: communityId,
              viewerId: identity.publicKey,
            });
            if (!cancelled) {
              setKeyCount(connectionsForViewer(view, identity.publicKey).length);
            }
          }
        } catch {
          // The key count is best-effort; the row still opens the Workbench.
        }
        try {
          if (monolithEnabled) {
            const hosted = await monolithPhoneOperation('getManagedIdentity', {});
            if (!cancelled) {
              setFace(hosted.face ?? null);
              setPushLevel(hosted.pushLevel);
              await saveStoredPushLevel(identity.publicKey, hosted.pushLevel);
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
            }
            return;
          }
          const hostedIdentity = await lookupManagedIdentity(
            getBuzzRuntimeConfig().relayUrl,
            identity,
          );
          if (!cancelled && hostedIdentity) {
            setManagedIdentity(hostedIdentity);
            setProfileName(hostedIdentity.displayName);
          }
        } catch {
          // Handle and face stay on whatever the profile read already supplied.
        }
      } catch (caught) {
        if (!cancelled) setError(`Could not load your profile: ${String(caught)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monolithEnabled]);

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
  const pushOn = pushSwitchValue(pushEnabled, pushRegistration);

  const changePushLevel = useCallback(
    async (next: PushLevel) => {
      if (!profileIdentity || pushWorking) return;
      setPushWorking(true);
      setError(null);
      try {
        const updated = await monolithPhoneOperation('updateIdentityPushLevel', {
          pushLevel: next,
        });
        setPushLevel(updated.pushLevel);
        await saveStoredPushLevel(profileIdentity.publicKey, updated.pushLevel);
        if (updated.pushLevel === 'off') {
          const notifications = await import('expo-notifications');
          await reconcilePresentedNotificationBadge(notifications, Platform.OS, 'off');
        } else if (!pushOn) {
          const result = await setBuzzPushEnabled(profileIdentity, true);
          await applyPushResult(profileIdentity, result, pushRegistration);
        }
      } catch (caught) {
        setError(`Could not update notifications: ${String(caught)}`);
        throw caught;
      } finally {
        setPushWorking(false);
      }
    },
    [applyPushResult, profileIdentity, pushOn, pushRegistration, pushWorking],
  );

  const pushRegistrationFailed =
    pushEnabled === true &&
    pushRegistration !== null &&
    !pushRegistration.registered &&
    buzzPushPhaseDetail(pushRegistration.phase) !== null;
  const managedHandle = managedIdentity?.handle ?? (profileName ? personHandle(profileName, profilePubkey ?? '') : '');
  const githubLogin = managedIdentity?.githubLogin ?? managedHandle;
  const pushSupported = pushPermission !== null && pushPermission.status !== 'unsupported';
  const [appearance, setAppearance] = useLocalSettingMutable('appearance');
  const [uiSize, setUiSize] = useLocalSettingMutable('uiSize');
  const changeAppearance = useCallback(
    (next: typeof appearance) => {
      setAppearance(next);
      setAppDisplay(next, uiSize);
    },
    [setAppearance, uiSize],
  );
  const changeUiSize = useCallback(
    (next: typeof uiSize) => {
      setUiSize(next);
      setAppDisplay(appearance, next);
    },
    [appearance, setUiSize],
  );

  const openGitHubProfile = useCallback(() => {
    if (!githubLogin) return;
    void openExternalUrl(`https://github.com/${githubLogin}`).catch(() => undefined);
  }, [githubLogin]);

  const faceMark = profilePubkey ? (
    <IdentityMark
      kind="human"
      seed={profilePubkey}
      face={face ?? defaultFaceForSeed(profilePubkey)}
      name={profileName || 'You'}
      size={IDENTITY_MARK}
      testID="identity-face-mark"
    />
  ) : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <HullSurface strength="quiet" style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <ChevronGlyph
            color={styles.backButtonText.color}
            direction="left"
            size={CHEVRON_BACK_SIZE}
          />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Settings</Text>
        </View>
      </HullSurface>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {profilePubkey && (
          <View style={styles.ident} testID="identity-settings">
            {monolithEnabled ? (
              <TouchableOpacity
                accessibilityLabel="Change face"
                accessibilityRole="button"
                onPress={() => setFacePickerOpen(true)}
                style={styles.tile}
                testID="identity-face-setting"
              >
                {faceMark}
              </TouchableOpacity>
            ) : (
              <View style={styles.tile} testID="identity-face-setting">
                {faceMark}
              </View>
            )}
            {managedHandle ? (
              <TouchableOpacity
                accessibilityLabel={`@${managedHandle}`}
                accessibilityRole="link"
                onPress={openGitHubProfile}
                testID="identity-managed-handle"
              >
                <Text style={styles.handle}>
                  <Text style={styles.handleAt}>@</Text>
                  <Text style={styles.handle}>{managedHandle}</Text>
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}

        {monolithEnabled && (
          <View style={styles.section} testID="workbench-section">
            <Text style={styles.sectionLabel}>Workbench</Text>
            <SettingsRow
              accessibilityLabel="Open your Workbench"
              chevron="right"
              onPress={() => router.push('/beeline/settings/workbench' as never)}
              testID="settings-workbench-row"
              title="Tools and keys"
              value={keyCount !== null ? String(keyCount) : undefined}
            />
          </View>
        )}

        <View style={styles.section} testID="appearance-section">
          {pushSupported ? (
            <View testID="notifications-section">
              <PushLevelSetting
                disabled={pushEnabled === null || pushWorking}
                onSave={changePushLevel}
                value={pushLevel}
              />
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
          <AppearanceSetting onChange={changeAppearance} value={appearance} />
          <UiSizeSetting onChange={changeUiSize} value={uiSize} />
        </View>

        <View style={styles.section} testID="legal-settings">
          <SettingsRow
            accessibilityLabel={t('settings.privacyPolicy')}
            accessibilityRole="link"
            chevron="right"
            onPress={() => void openExternalUrl(PRIVACY_URL).catch(() => undefined)}
            testID="settings-privacy-row"
            title={t('settings.privacyPolicy')}
          />
          <SettingsRow
            accessibilityLabel={t('settings.termsOfService')}
            accessibilityRole="link"
            chevron="right"
            onPress={() => void openExternalUrl(TERMS_URL).catch(() => undefined)}
            testID="settings-terms-row"
            title={t('settings.termsOfService')}
          />
          <SettingsRow
            accessibilityLabel="Send feedback"
            accessibilityRole="link"
            chevron="right"
            onPress={() => void openExternalUrl(FEEDBACK_MAILTO).catch(() => undefined)}
            testID="settings-feedback-row"
            title="Send feedback"
          />
        </View>

        <View style={styles.section} testID="account-settings">
          <SettingsRow
            accessibilityLabel={confirmSignOut ? 'Confirm sign out' : 'Sign out on this device'}
            onPress={() => void signOut()}
            testID="sign-out-setting"
            title="Sign out"
            tone="destructive"
          />
          <SettingsRow
            accessibilityLabel={confirmDelete ? 'Confirm delete account' : 'Delete account'}
            disabled={deleteBusy}
            onPress={() => void deleteAccount()}
            testID="delete-account-setting"
            title={deleteBusy ? 'Deleting…' : 'Delete account'}
            tone="destructive"
          />
        </View>

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

        <View style={styles.foot} testID="ota-update-info">
          <BeelineMark size={32} />
          <Text style={styles.version}>Beeline version {releaseValue}</Text>
          {manualUpdateMessage(manualUpdate) ? (
            <Text style={styles.version}>{manualUpdateMessage(manualUpdate)}</Text>
          ) : null}
          {manualUpdateBusy ? (
            <View testID="ota-update-progress">
              <PixelLoader compact />
            </View>
          ) : (
            <TouchableOpacity
              accessibilityLabel={manualUpdateButtonLabel(manualUpdate)}
              disabled={!Updates.isEnabled}
              onPress={() => void checkForUpdate()}
              style={!Updates.isEnabled ? styles.disabled : undefined}
              testID="ota-update-check"
            >
              <Text style={styles.check}>Check</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>

      {profilePubkey && monolithEnabled ? (
        <FacePickerSheet
          face={face}
          onClose={() => setFacePickerOpen(false)}
          onFaceChange={setFace}
          onSave={(next) => monolithPhoneOperation('updateIdentityFace', { faceId: next })}
          seed={profilePubkey}
          visible={facePickerOpen}
        />
      ) : null}
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
    backButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    backButtonText: { color: hull.textPrimary },
    headerCopy: { flex: 1, minWidth: 0 },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    content: {
      paddingHorizontal: hull.space.md,
      paddingBottom: hull.space.xxl,
    },
    ident: {
      alignItems: 'center',
      gap: hull.space.md,
      paddingTop: hull.space.lg,
      paddingBottom: hull.space.lg,
    },
    tile: {
      width: IDENTITY_TILE,
      height: IDENTITY_TILE,
      borderRadius: IDENTITY_TILE_RADIUS,
      borderWidth: 2,
      borderColor: hull.accent,
      backgroundColor: hull.bgRaised,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    handle: {
      ...Typography.default(),
      ...hull.type.bodyStrong,
      color: hull.textPrimary,
      textAlign: 'center',
    },
    handleAt: {
      ...Typography.default(),
      ...hull.type.bodyStrong,
      color: hull.accent,
    },
    section: {},
    sectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      paddingTop: hull.space.md,
    },
    disabled: { opacity: 0.42 },
    pushRetryButton: {
      minHeight: 44,
      paddingHorizontal: hull.space.md,
      justifyContent: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    pushRetryText: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    notice: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      paddingHorizontal: hull.space.md,
    },
    warning: {
      padding: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
    },
    warningText: { ...Typography.default(), ...hull.type.meta, flex: 1, color: hull.textSecondary },
    cancelAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: hull.space.sm },
    cancelText: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    errorPanel: {
      padding: hull.space.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
    },
    errorLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.danger },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    foot: {
      alignItems: 'center',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.md,
      paddingTop: hull.space.xl,
      paddingBottom: hull.space.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    version: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, textAlign: 'center' },
    check: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
  };
});
