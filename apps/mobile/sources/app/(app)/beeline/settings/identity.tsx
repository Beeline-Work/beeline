import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop } from '@/utils/responsive';
import { Button } from '@/components/buzz/Button';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Updates from 'expo-updates';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  fallbackPersonName,
  personHandle,
  isWorkspaceListView,
  isWorkspaceView,
  type Identity,
} from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';
import {
  getEffectiveRelayUrl,
  clearBuzzIdentity,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { loadPreferredPersonName } from '@/buzz/person-name';
import { workbenchSummary } from '@/buzz/connectors-model';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { isManagedIdentity, publishManagedIdentity, readIdentitySettings } from '@/buzz/managed-identity-surface';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { Typography } from '@/constants/Typography';
import { PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
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
import { PROFILE_IDENTITY_PICTURE_SIZE, ProfileIdentity } from '@/components/buzz/ProfileIdentity';
import {
  SETTINGS_SCOPE_PICTURE_SIZE,
  SettingsScopeTabs,
  type SettingsScope,
} from '@/components/buzz/SettingsScopeTabs';
import WorkspaceSettings, {
  WORKSPACE_VISIBILITY_LABELS,
  type WorkspaceSettingsHandle,
} from '@/components/buzz/WorkspaceSettingsPanel';
import { FacePickerSheet } from '@/components/buzz/FacePickerSheet';
import { PushLevelSetting } from '@/components/buzz/PushLevelSetting';
import { AppearanceSetting } from '@/components/buzz/AppearanceSetting';
import { UiSizeSetting } from '@/components/buzz/UiSizeSetting';
import { applyAppearanceChoice, setAppDisplay } from '@/unistyles';
import { useLocalSettingMutable } from '@/sync/storage';
import { roomOpenTraceEnabled } from '@/buzz/room-open-trace';
import { githubConnectionErrorMessage } from '@/auth/github-connection-error';
import { clearPendingGitHubSignInState } from '@/auth/github-auth-session';
import { monolithSession } from '@/auth/monolith-session';
import { clearMobileSurfaceStorage, surfaceAddress } from '@/buzz/surface-storage';
import { saveStoredPushLevel, watchStoredPushLevel } from '@/push/push-level-storage';
import { subscribeOwnIdentityChange } from '@/buzz/identity-live';
import { reconcilePresentedNotificationBadge } from '@/push/presented-notifications';
import { loadAppConfig } from '@/sync/appConfig';
import { openExternalUrl } from '@/utils/open-external-url';
import { PageHeader } from '@/components/buzz/PageHeader';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import {
  createManualUpdateState,
  isManualUpdateBusy,
  manualUpdateButtonLabel,
  manualUpdateMessage,
  manualUpdateReducer,
} from './manual-update-state';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const PRIVACY_URL = 'https://usebeeline.app/privacy/';
const TERMS_URL = 'https://usebeeline.app/terms/';
const FEEDBACK_MAILTO = 'mailto:hello@usebeeline.app';
export default function BuzzIdentitySettings() {
  const desktop = useIsDesktop();
  useLatencyRouteFrame('/beeline/settings/identity');
  const { githubReconnect, githubConnectionError, tab, workspaceId: linkedWorkspaceId } = useLocalSearchParams<{
    githubReconnect?: string; githubConnectionError?: string; tab?: string; workspaceId?: string;
  }>();
  const [scope, setScope] = useState<SettingsScope>(tab === 'workspace' ? 'workspace' : 'you');
  useEffect(() => {
    if (tab === 'workspace') setScope('workspace');
  }, [tab, linkedWorkspaceId]);
  const workspaceSettings = useRef<WorkspaceSettingsHandle>(null);
  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [profileIdentity, setProfileIdentity] = useState<Identity | null>(null);
  const [profilePubkey, setProfilePubkey] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [pushEnabled, setPushEnabledState] = useState<boolean | null>(null);
  const [pushRegistration, setPushRegistration] = useState<BuzzPushRegistrationState | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
  const [pushWorking, setPushWorking] = useState(false);
  const [pushLevel, setPushLevel] = useState<PushLevel>('attention');
  const currentWorkspaceId = useActiveCommunityId();
  const [profileRelay, setProfileRelay] = useState<string | null>(null);
  const managedAddress = useMemo(() => profileRelay && profilePubkey
    ? surfaceAddress(profileRelay, profilePubkey, '/identity/managed') : null,
    [profileRelay, profilePubkey]);
  const managedProjection = useSurfaceSnapshot(managedAddress, isManagedIdentity);
  const [workspaceListConfirmed, setWorkspaceListConfirmed] = useState(false);
  const workspaceAddress = useMemo(() => profileRelay && profilePubkey
    ? surfaceAddress(profileRelay, profilePubkey, '/workspaces') : null,
    [profileRelay, profilePubkey]);
  const workspaceListView = useSurfaceSnapshot(workspaceAddress, isWorkspaceListView);
  const workspaceList = workspaceListView && {
    workspaces: workspaceListView.workspaces,
    confirmed: workspaceListConfirmed,
  };
  // A link to one workspace's settings names it; otherwise Settings shows the current one.
  const selectedWorkspace = workspaceList?.workspaces.find((item) => item.id === linkedWorkspaceId) ??
    workspaceList?.workspaces.find((item) => item.id === currentWorkspaceId) ??
    workspaceList?.workspaces[0];
  const selectedWorkspaceAddress = useMemo(() => profileRelay && profilePubkey && selectedWorkspace
    ? surfaceAddress(profileRelay, profilePubkey, '/workspace/:id', { workspaceId: selectedWorkspace.id }) : null,
    [profileRelay, profilePubkey, selectedWorkspace?.id]);
  // The tab's own read, when it has one, is fresher than the list (a new picture or name).
  const selectedWorkspaceView = useSurfaceSnapshot(selectedWorkspaceAddress, isWorkspaceView);
  const headerWorkspace = selectedWorkspace && selectedWorkspaceView?.workspace.id === selectedWorkspace.id
    ? { ...selectedWorkspace, ...selectedWorkspaceView.workspace } : selectedWorkspace;
  const workspaceRole = selectedWorkspace?.role ?? null;
  const workbenchScope = selectedWorkspace && workspaceListConfirmed && profilePubkey
    ? { workspaceId: selectedWorkspace.id, viewerId: profilePubkey } : null;
  const [face, setFace] = useState<string | null>(null);
  const [facePickerOpen, setFacePickerOpen] = useState(false);
  const [githubNotice, setGitHubNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!profilePubkey) return;
    void (async () => {
      const google = await import('@/auth/google-auth-session');
      if (await google.pendingGoogleLinkIdentity() !== profilePubkey) return;
      const { getInitialURL } = await import('expo-linking');
      const ticket = await google.resumeGoogleSignIn(await getInitialURL());
      if (!ticket) return;
      await google.completeGoogleAccountLink(ticket, profilePubkey);
      await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
    })().catch(reason => setGitHubNotice(reason instanceof Error ? reason.message : String(reason)));
  }, [profilePubkey]);
  const [googleBusy, setGoogleBusy] = useState(false);
  const connectGoogle = async () => {
    if (googleBusy || !profilePubkey) return;
    setGoogleBusy(true);
    setGitHubNotice(null);
    try {
      const [{ runGoogleSignIn, completeGoogleAccountLink }, { getRandomBytes },
        { openAccountAuthSession, subscribeToAuthUrls }, { authSessionOptions }] = await Promise.all([
        import('@/auth/google-auth-session'), import('expo-crypto'),
        import('@/auth/desktop-auth-session'), import('@/auth/auth-session'),
      ]);
      const token = () => btoa(String.fromCharCode(...getRandomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const ticket = await runGoogleSignIn({ state: token(), recoveryToken: token(), linkIdentity: profilePubkey,
        openAuthSession: (url, redirect) => openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect)),
        subscribeToUrls: subscribeToAuthUrls });
      await completeGoogleAccountLink(ticket, profilePubkey);
      await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
    } catch (reason) { setGitHubNotice(reason instanceof Error ? reason.message : String(reason)); }
    finally { setGoogleBusy(false); }
  };
  const [githubBusy, setGitHubBusy] = useState(false);
  const connectGitHub = async () => {
    if (githubBusy) return;
    setGitHubBusy(true);
    setGitHubNotice(null);
    try {
      const [{ runHostGitHubInstallationSession }, { githubInstallationRedirectUri }] = await Promise.all([
        import('@/auth/github-installation-host'), import('@/auth/github-auth-session'),
      ]);
      await runHostGitHubInstallationSession({
        returnPath: '/beeline/settings/identity',
        startInstallation: async () => (await monolithPhoneOperation('beginGitHubInstallation', {
          redirectUri: githubInstallationRedirectUri(), reconnect: true,
        })).url,
        refreshRepositories: async () => {
          await monolithPhoneOperation('listGitHubRepositories', { refresh: true });
          await publishManagedIdentity(await monolithPhoneOperation('getManagedIdentity', {}));
        },
        onRefreshPhase: () => undefined,
      });
    } catch (reason) {
      setGitHubNotice(reason instanceof Error ? reason.message : String(reason));
    } finally { setGitHubBusy(false); }
  };
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
    if (githubConnectionError) setGitHubNotice(githubConnectionErrorMessage(githubConnectionError));
    else if (githubReconnect === 'success') setGitHubNotice('GitHub reconnected.');
    else if (githubReconnect === 'mismatch')
      setGitHubNotice('Reconnect the GitHub account already linked to this identity.');
    else if (githubReconnect === 'failed')
      setGitHubNotice('Could not reconnect GitHub. Try again.');
  }, [githubReconnect, githubConnectionError]);
  useEffect(() => {
    // A change on another device reaches this mounted page through the
    // server's identity subscription, which also refreshes the device copies.
    if (!profilePubkey) return;
    const stopLevel = watchStoredPushLevel(profilePubkey, setPushLevel);
    const stopIdentity = subscribeOwnIdentityChange((person) => {
      setProfileName(person.name);
      setFace(null);
    });
    return () => {
      stopLevel();
      stopIdentity();
    };
  }, [profilePubkey]);

  const signOut = useCallback(async () => {
    await Promise.all([
      monolithSession.signOut(),
      clearBuzzIdentity(),
      clearPendingGitHubSignInState(),
    ]);
    clearMobileSurfaceStorage();
    router.replace('/beeline/onboarding');
  }, []);

  const deleteAccount = useCallback(async () => {
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
  }, [deleteBusy, profileIdentity]);

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

  // The profile name is read for the current Workspace, again after a switch.
  useEffect(() => {
    if (currentWorkspaceId === undefined) return;
    let cancelled = false;
    setWorkspaceListConfirmed(false);
    void (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) return;
        // The device already holds the identity, so the tile is drawn from it
        // before any read. A failing profile read then costs the name, not the
        // face and handle.
        if (!cancelled) {
          setProfileIdentity(identity);
          setProfilePubkey(identity.publicKey);
          setProfileName((current) => current || fallbackPersonName(identity.publicKey));
        }
        // The device copy of the name is only a cold-start hint until the server answers.
        const preferredName = await loadPreferredPersonName(identity.publicKey);
        if (preferredName && !cancelled) setProfileName(preferredName);
        setProfileRelay(await getEffectiveRelayUrl());
        const [settings, enabled, registration, permission] = await Promise.all([
          readIdentitySettings(currentWorkspaceId ?? undefined),
          getBuzzPushEnabled(identity.publicKey),
          getBuzzPushRegistrationState(identity.publicKey),
          getPushPermissionInfo(),
        ]);
        if (cancelled) return;
        setWorkspaceListConfirmed(true);
        setPushEnabledState(enabled);
        setPushRegistration(registration);
        setPushPermission(permission);
        await saveStoredPushLevel(identity.publicKey, settings.identity.pushLevel);
      } catch (caught) {
        if (!cancelled) setError(`Could not load your profile: ${String(caught)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId]);

  const { value: workbenchView } = useSharedWorkbench(workbenchScope);
  const workbench = workbenchView && workbenchScope
    ? workbenchSummary(workbenchView, workbenchScope.viewerId) : null;

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
        await publishManagedIdentity(updated);
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

  const shownPushLevel = managedProjection?.pushLevel ?? pushLevel;
  const pushRegistrationFailed =
    shownPushLevel !== 'off' &&
    pushEnabled === true &&
    pushRegistration !== null &&
    !pushRegistration.registered &&
    buzzPushPhaseDetail(pushRegistration.phase) !== null;
  const displayName = managedProjection?.name ?? profileName;
  const displayFace = face ?? managedProjection?.face ?? null;
  const managedHandle = managedProjection?.handle ??
    (displayName ? personHandle(displayName, profilePubkey ?? '') : '');
  const githubLogin = managedProjection?.providers?.find((link) => link.provider === 'github')?.login;
  const pushSupported = pushPermission !== null && pushPermission.status !== 'unsupported';
  const [appearance, setAppearance] = useLocalSettingMutable('appearance');
  const [uiSize, setUiSize] = useLocalSettingMutable('uiSize');
  const [roomOpenTrace, setRoomOpenTrace] = useLocalSettingMutable('roomOpenTraceOverlay');
  const changeAppearance = useCallback(
    (next: typeof appearance) => {
      setAppearance(next);
      applyAppearanceChoice(next, uiSize);
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

  // Only owners and admins see workspace settings; a member's Settings is theirs alone.
  const canManageWorkspace = workspaceRole === 'owner' || workspaceRole === 'admin';
  const workspaceTab = headerWorkspace && workspaceListConfirmed && canManageWorkspace ? {
    accessibilityLabel: `${headerWorkspace.name} ${WORKSPACE_LABEL.toLowerCase()} settings`,
    label: headerWorkspace.name,
    picture: (
      <IdentityMark
        kind="workspace"
        seed={headerWorkspace.id}
        avatarUrl={headerWorkspace.avatar}
        name={headerWorkspace.name}
        size={SETTINGS_SCOPE_PICTURE_SIZE}
        testID="workspace-picture-mark"
      />
    ),
    selectedAction: { accessibilityHint: 'Change picture', onPress: () => workspaceSettings.current?.changePicture() },
    testID: 'settings-workspace-tab',
    tileTestID: 'workspace-picture-change',
  } : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <PageHeader
        backAccessibilityLabel="Back"
        onBack={() => router.back()}
        prominent
        testID="settings-profile-header"
        title="Settings"
      />

      <ScrollView contentContainerStyle={[styles.content, desktop && styles.desktopColumn]} keyboardShouldPersistTaps="handled">
        <View testID="identity-settings">
          {workspaceTab ? (
          <SettingsScopeTabs
            scope={scope}
            onScopeChange={setScope}
            you={{
              accessibilityLabel: 'Your settings',
              label: 'You',
              // Until a face is saved, the tile shows the Beeline mark.
              picture: displayFace ? (
                <IdentityMark
                  kind="human"
                  seed={profilePubkey ?? 'pending-profile'}
                  name={displayName || 'You'}
                  face={displayFace}
                  size={SETTINGS_SCOPE_PICTURE_SIZE}
                  testID="identity-face-mark"
                />
              ) : <BeelineMark size={SETTINGS_SCOPE_PICTURE_SIZE} />,
              selectedAction: profilePubkey
                ? { accessibilityHint: 'Change face', onPress: () => setFacePickerOpen(true) }
                : undefined,
              testID: 'settings-you-tab',
              tileTestID: 'identity-face-setting',
            }}
            workspace={workspaceTab}
            caption={scope === 'workspace' && workspaceTab && headerWorkspace ? (
              <>
                {headerWorkspace.visibility ? `${WORKSPACE_VISIBILITY_LABELS[headerWorkspace.visibility]} ${WORKSPACE_LABEL.toLowerCase()} · ` : ''}
                you are <Text style={styles.captionStrong}>{headerWorkspace.role}</Text>
              </>
            ) : managedHandle ? (
              <>
                <Text
                  accessibilityRole={githubLogin ? 'link' : undefined}
                  onPress={githubLogin ? openGitHubProfile : undefined}
                  style={styles.captionHandle}
                  testID="identity-managed-handle"
                >
                  {`@${managedHandle}`}
                </Text>
                {workspaceRole ? ` · ${workspaceRole}` : ''}
              </>
            ) : workspaceRole ?? undefined}
          />
          ) : (
          <ProfileIdentity
            avatarAccessibilityLabel="Change face"
            avatarFallback={displayFace ? undefined : <BeelineMark size={PROFILE_IDENTITY_PICTURE_SIZE} />}
            avatarTestID="identity-face-setting"
            handleAccessibilityLabel={managedHandle ? `@${managedHandle}` : undefined}
            handleTestID="identity-managed-handle"
            hideUnavailableHandle
            identity={{
              kind: 'human',
              pubkey: profilePubkey ?? 'pending-profile',
              name: displayName || 'You',
              ...(managedHandle ? { handle: managedHandle } : {}),
              ...(displayFace ? { face: displayFace } : {}),
            }}
            identityMarkTestID="identity-face-mark"
            onAvatarPress={
              profilePubkey ? () => setFacePickerOpen(true) : undefined
            }
            onHandlePress={githubLogin ? openGitHubProfile : undefined}
            role={workspaceRole ?? undefined}
          />
          )}
        </View>

        {scope === 'workspace' && workspaceTab && headerWorkspace ? (
          <WorkspaceSettings key={headerWorkspace.id} ref={workspaceSettings} workspaceId={headerWorkspace.id} />
        ) : (
        <>
        <View style={styles.section} testID="workbench-section">
          <RoomListSectionHeader title="Connectors" inset="content" />
          <SettingsRow
            accessibilityLabel="Open your Connectors"
            chevron="right"
            onPress={() => router.push({
              pathname: '/beeline/settings/workbench',
              params: {
                workspaceId: selectedWorkspace?.id ?? currentWorkspaceId ?? '',
                viewerId: profilePubkey ?? '',
              },
            } as never)}
            testID="settings-workbench-row"
            title="Your connections"
            wholeTitle
            value={workbench?.value}
            description={workbench?.attention}
            descriptionTone={workbench?.attention ? 'danger' : undefined}
          />
        </View>

        <View style={styles.section} testID="appearance-section">
          <RoomListSectionHeader title="Device" inset="content" />
          {pushSupported ? (
            <View testID="notifications-section">
              <PushLevelSetting
                disabled={pushEnabled === null || pushWorking}
                onSave={changePushLevel}
                value={shownPushLevel}
              />
              {pushRegistrationFailed && pushRegistration ? (
                <SettingsRow
                  action={pushWorking ? 'Retrying notifications…' : 'Retry notifications'}
                  description={capitalize(buzzPushPhaseDetail(pushRegistration.phase) ?? '')}
                  descriptionTone="danger"
                  disabled={pushWorking}
                  onPress={() => void retryPushRegistration()}
                  testID="push-retry-registration"
                  title="Push not working"
                />
              ) : null}
            </View>
          ) : null}
          <AppearanceSetting onChange={changeAppearance} value={appearance} />
          <UiSizeSetting onChange={changeUiSize} value={uiSize} />
          {roomOpenTraceEnabled() && (
            <View testID="debug-settings">
              <SettingsRow
                accessibilityLabel={
                  roomOpenTrace
                    ? 'Disable room open trace overlay'
                    : 'Enable room open trace overlay'
                }
                description="Show open timings on screen"
                onPress={() => setRoomOpenTrace(!roomOpenTrace)}
                testID="debug-room-open-trace"
                title="Room open trace"
                value={roomOpenTrace ? 'On' : 'Off'}
              />
            </View>
          )}
        </View>

        <View style={styles.section} testID="account-settings">
          <RoomListSectionHeader title="Account" inset="content" />
          {managedProjection?.providers?.map((link) => (
                <SettingsRow
                  key={link.provider}
                  title={link.provider === 'google' ? 'Google' : 'GitHub'}
                  description={link.login}
                  value={link.reconnect ? 'Reconnect' : managedProjection.providers?.length === 1 ? 'Signed in' : 'Linked'}
                  onPress={link.provider === 'github' ? () => void connectGitHub() : undefined}
                  disabled={githubBusy}
                  testID={`settings-provider-${link.provider}`}
                />
              ))}
          {managedProjection && !managedProjection.providers?.some(link => link.provider === 'github') ? (
            <SettingsRow title="GitHub" description="Needed to link repositories" value="Connect"
              onPress={() => void connectGitHub()} disabled={githubBusy} testID="settings-provider-github" />
          ) : null}
          {managedProjection && !managedProjection.providers?.some(link => link.provider === 'google') ? (
            <SettingsRow title="Google" value="Connect" onPress={() => void connectGoogle()}
              disabled={googleBusy} testID="settings-provider-google" />
          ) : null}
          <View testID="legal-settings">
            <SettingsRow
              accessibilityLabel={"Privacy Policy"}
              accessibilityRole="link"
              chevron="right"
              onPress={() => void openExternalUrl(PRIVACY_URL).catch(() => undefined)}
              testID="settings-privacy-row"
              title={"Privacy Policy"}
            />
            <SettingsRow
              accessibilityLabel={"Terms of Service"}
              accessibilityRole="link"
              chevron="right"
              onPress={() => void openExternalUrl(TERMS_URL).catch(() => undefined)}
              testID="settings-terms-row"
              title={"Terms of Service"}
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
          <SettingsRow
            accessibilityLabel="Sign out on this device"
            onPress={() => void signOut()}
            testID="sign-out-setting"
            title="Sign out"
            tone="destructive"
          />
          <SettingsRow
            accessibilityLabel="Delete account"
            disabled={deleteBusy}
            onPress={() => setConfirmDelete(true)}
            testID="delete-account-setting"
            title={deleteBusy ? 'Deleting…' : 'Delete account'}
            tone="destructive"
          />
        </View>



        {githubNotice ? <Text style={styles.notice}>{githubNotice}</Text> : null}

        {confirmDelete ? (
          <PixelGateReveal style={styles.warning}>
            <Text style={styles.warningText}>
              deleting your account will delete all your data. this action is irrevocable. confirm?
            </Text>
            <HullDialogActions
              actions={[
                {
                  label: 'Cancel',
                  accessibilityLabel: 'Cancel account deletion',
                  disabled: deleteBusy,
                  onPress: () => setConfirmDelete(false),
                  testID: 'delete-account-cancel',
                },
                {
                  label: 'Delete account',
                  variant: 'destructive',
                  accessibilityLabel: 'Yes, delete account',
                  disabled: deleteBusy,
                  onPress: () => void deleteAccount(),
                  testID: 'delete-account-yes',
                },
              ]}
            />
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
            <Button
              label="Check"
              variant="quiet"
              accessibilityLabel={manualUpdateButtonLabel(manualUpdate)}
              disabled={!Updates.isEnabled}
              onPress={() => void checkForUpdate()}
              testID="ota-update-check"
              appearance={{ control: !Updates.isEnabled ? styles.disabled : undefined, label: styles.check }}
            />
          )}
        </View>
        </>
        )}
      </ScrollView>

      {profilePubkey ? (
        <FacePickerSheet
          face={displayFace}
          onClose={() => setFacePickerOpen(false)}
          onFaceChange={setFace}
          onSave={async (next) => {
            await monolithPhoneOperation('updateIdentityFace', { faceId: next });
            if (managedProjection) await publishManagedIdentity({ ...managedProjection, face: next });
            setFace(null);
          }}
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
    container: { flex: 1, backgroundColor: hull.bgBase },
    desktopColumn: { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' },
    content: {
      paddingHorizontal: hull.space.md,
      paddingBottom: hull.space.xxl,
    },
    section: {},
    captionHandle: { ...Typography.default('semiBold'), color: hull.accent },
    captionStrong: { ...Typography.default('semiBold'), color: hull.accent },
    disabled: { opacity: 0.42 },
    notice: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      paddingHorizontal: hull.space.md,
    },
    warning: {
      padding: hull.space.md,
      alignItems: 'stretch',
      gap: hull.space.md,
    },
    warningText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
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
    version: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
    },
    check: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
  };
});
