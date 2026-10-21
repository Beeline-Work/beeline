import { beginFunnelAttempt, pendingFunnelAttempt, funnelScreen, funnelCallback } from '@/auth/signin-funnel';
import { readAuthCapabilities, watchGooglePreview } from '@/auth/google-preview';
import { readRepositoryOnboardingEligibility, useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { clearPendingGoogleSignIn, resumeGoogleSignIn, runGoogleSignIn } from '@/auth/google-auth-session';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useTextDraft } from '@/buzz/use-text-draft';
/** Native GitHub-first onboarding. OAuth proves lookup only; the Nostr key remains device-held. */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { getRandomBytes } from 'expo-crypto';
import {
  lookupManagedIdentity,
  normalizeManagedHandle,
  OidcBindError,
  type BuzzClient,
  buildOidcBindEvent,
  finishOidcBind,
  recoverOidcBind,
  type Identity,
  type ManagedIdentity,
  type OidcBindChallenge,
} from '@beeline/buzz-client';
import {
  clearPendingGitHubIdentity,
  loadBuzzIdentity,
  loadPendingGitHubIdentity,
} from '@/auth/buzz-identity-storage';
import {
  clearOnboardingFaceStep,
  clearOnboardingNotice,
  isSignInInFlight,
  markSignInInFlight,
  nextOnboardingStatus,
  noticeForAuthError,
  publishOnboardingFaceStep,
  publishOnboardingNotice,
  subscribeToOnboardingFaceStep,
  subscribeToOnboardingNotices,
  type OnboardingFaceStep,
  type OnboardingNotice,
  type OnboardingStatus,
} from '@/auth/onboarding-state';
import { authSessionOptions } from '@/auth/auth-session';
import {
  clearPendingGitHubSignInState,
  cancelPendingGitHubSignIn,
  isPendingGitHubReconnect,
  loadPendingGitHubBindChallenge,
  recoverPendingGitHubBindChallenge,
  resumeInitialGitHubSignIn,
  runResilientGitHubSignInSession,
} from '@/auth/github-auth-session';
import {
  clearPersonNameOnboardingPending,
  loadPreferredPersonName,
  markPersonNameOnboardingPending,
  resolveOnboardingPersonName,
  savePreferredPersonName,
} from '@/buzz/person-name';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { Button } from '@/components/buzz/Button';
import { PixelGateReveal } from '@/components/buzz/MonoHull';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { GitHubAccountMismatchError, monolithSession } from '@/auth/monolith-session';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { YouStep } from '@/components/buzz/YouStep';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { isTauri } from '@/utils/isTauri';
import { accountSignInAvailable } from '@/auth/account-sign-in-platform';
import {
  initialAuthUrl,
  openAccountAuthSession,
  subscribeToAuthUrls,
} from '@/auth/desktop-auth-session';

WebBrowser.maybeCompleteAuthSession();

interface PendingBind {
  challenge: OidcBindChallenge;
  identity: Identity;
  bound: boolean;
  managedIdentity?: ManagedIdentity;
}

async function exchangeFunnelTicket(ticket:string, provider: 'github' | 'google' = 'github'){
  const context=await pendingFunnelAttempt().catch(()=>undefined);
  return provider === 'google'
    ? monolithSession.exchangeGoogleTicket(ticket, context)
    : monolithSession.exchangeGitHubTicket(ticket, context);
}

function randomState(): string {
  return btoa(String.fromCharCode(...getRandomBytes(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

const WEB_NOTICE: OnboardingNotice = {
  status: 'idle',
  title: 'NATIVE ONLY',
  message:
    'Account sign-in is available in the Android and iOS app. Web key storage is not hardened for this flow.',
  retryable: false,
};
const DESKTOP_WORDMARK_SCALE = 34 / 28;
/** The key input's resting and focused borders. The focused state trims its
 *  padding by the extra border so the text never shifts. */
const INPUT_BORDER_WIDTH = 1;
const INPUT_FOCUSED_BORDER_WIDTH = 2;

export default function BuzzOnboarding() {
  const repositoryOnboarding = useRepositoryOnboarding();
  useEffect(() => { void funnelScreen().catch(()=>undefined); }, []);
  useLatencyRouteFrame('/beeline/onboarding', true, true);
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const pendingBind = useRef<PendingBind | null>(null);
  const existingIdentity = useRef<Identity | null>(null);
  const canSignIn = accountSignInAvailable(Platform.OS, isTauri());
  const [status, setStatus] = useState<OnboardingStatus>('checking_device');
  const [notice, setNotice] = useState<OnboardingNotice | null>(canSignIn ? null : WEB_NOTICE);
  const [loadingAction, setLoadingAction] = useState<
    'google' | 'github' | 'bind' | 'recover' | 'name' | null
  >(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  useEffect(() => {
    const runtime = getBuzzRuntimeConfig();
    let alive = true;
    const refresh = () => {
      void readAuthCapabilities(runtime.monolithUrl)
        .then(capabilities => { if (alive) setGoogleEnabled(capabilities.google === true); })
        .catch(() => undefined);
    };
    const unwatch = watchGooglePreview(refresh);
    refresh();
    return () => { alive = false; unwatch(); };
  }, []);
  const [nameFocused, setNameFocused] = useState(false);
  const [namingIdentity, setNamingIdentity] = useState<Identity | null>(null);
  const [namingClient, setNamingClient] = useState<BuzzClient | null>(null);
  const [nameInput, setNameInput, onboardingNameDraft] = useTextDraft('onboarding:name',
    '',
    namingIdentity?.publicKey ?? null,
  );
  // The You step (handle + face): published once the monolith identity exists,
  // cleared by the crossfade into the app. `face` is a face already on record.
  const [faceStep, setFaceStep] = useState<OnboardingFaceStep | null>(null);
  const loading = loadingAction !== null;

  // The You step reaches whichever onboarding screen is on the page, not only
  // the one whose press started the sign-in — the GitHub callback deep link
  // routes a second one over it before the exchange comes back.
  useEffect(() => subscribeToOnboardingFaceStep(setFaceStep), []);

  /**
   * After a monolith sign-in the identity exists; before the app opens the
   * person sees their GitHub handle and chooses their face. A person who already
   * chose (a returning sign-in on a new device) goes straight in — both live
   * in Settings.
   */
  const enterAfterMonolithSignIn = async (identityId: string | undefined) => {
    if (await readRepositoryOnboardingEligibility())
      await monolithPhoneOperation('listGitHubRepositories', { refresh: true });
    const seed = identityId || (await monolithSession.identityId().catch(() => null)) || '';
    const hosted = await monolithPhoneOperation('getManagedIdentity', {}).catch(() => null);
    if (hosted?.face) {
      router.replace('/beeline/channels');
      return;
    }
    publishOnboardingFaceStep({
      seed,
      face: null,
      name: hosted?.name ?? '',
      handle: hosted?.handle,
      provider: hosted?.providers?.some((link) => link.provider === 'google') ? 'google' : 'github',
    });
  };

  const restorePendingBind = async (): Promise<boolean> => {
    const [challenge, identity] = await Promise.all([
      loadPendingGitHubBindChallenge(),
      loadBuzzIdentity().then(async (saved) => saved ?? (await loadPendingGitHubIdentity())),
    ]);
    if (!challenge || !identity) return false;
    existingIdentity.current = identity;
    pendingBind.current = { challenge, identity, bound: false };
    return true;
  };

  useEffect(
    () =>
      subscribeToOnboardingNotices((next) => {
        if (next.status === 'link_conflict' && !pendingBind.current) {
          void restorePendingBind()
            .then((restored) => {
              if (restored) {
                setStatus(next.status);
                setNotice(next);
                return;
              }
              const expired = noticeForAuthError(
                new OidcBindError(
                  'ticket_expired',
                  'The replacement proof is no longer available. Sign in again.',
                  410,
                ),
              );
              setStatus(expired.status);
              setNotice(expired);
            })
            .catch((error: unknown) => {
              const failed = noticeForAuthError(error);
              setStatus(failed.status);
              setNotice(failed);
            });
          return;
        }
        setStatus(next.status);
        setNotice(next);
      }),
    [],
  );

  const continueAfterIdentity = async (
    identity: Identity,
    suppliedManagedIdentity?: ManagedIdentity,
    requireManagedHandle = false,
  ) => {
    setStatus('entering_workspace');
    try {
      const transport = new BuzzRigTransport(identity);
      const client = await transport.ensureClient();
      const enterWithManagedIdentity = async (managedIdentity: ManagedIdentity) => {
        let displayName = managedIdentity.displayName;
        try {
          const current = await client.getGlobalPersonProfile(identity.publicKey).catch(() => null);
          displayName = current?.name ?? managedIdentity.displayName;
          await client.setGlobalPersonProfile({
            name: displayName,
            handle: managedIdentity.handle,
            avatar: current?.avatar,
          });
        } catch {
          // The server-side assignment is already authoritative. Profile
          // publication can retry after entry; GitHub users are never sent to
          // a redundant naming prompt because relay projection is delayed.
        }
        await savePreferredPersonName(identity.publicKey, displayName).catch(() => undefined);
        await clearPersonNameOnboardingPending().catch(() => undefined);
        router.replace('/beeline/channels');
      };
      const managedIdentity =
        suppliedManagedIdentity ??
        (await lookupManagedIdentity(getBuzzRuntimeConfig().relayUrl, identity).catch(() => null));
      if (managedIdentity) {
        await enterWithManagedIdentity(managedIdentity);
        return;
      }
      if (!requireManagedHandle) {
        const resolved = await resolveOnboardingPersonName(client, identity.publicKey);
        if (!resolved.needsPrompt) {
          await clearPersonNameOnboardingPending();
          router.replace('/beeline/channels');
          return;
        }
      }
      setNamingClient(client);
      setNamingIdentity(identity);
      setNotice(null);
    } catch {
      if (!requireManagedHandle) {
        const preferred = await loadPreferredPersonName(identity.publicKey);
        if (preferred) {
          await clearPersonNameOnboardingPending();
          router.replace('/beeline/channels');
          return;
        }
      }
      setNamingClient(null);
      setNamingIdentity(identity);
      setNotice(null);
    }
  };

  const finishPendingBind = async (pending: PendingBind) => {
    setLoadingAction('bind');
    setStatus('binding');
    clearOnboardingNotice();
    setNotice(null);
    try {
      if (!pending.bound) {
        if (pending.challenge.expires_at <= Math.floor(Date.now() / 1_000)) {
          throw new OidcBindError('ticket_expired', 'The bind ticket expired', 410);
        }
        const event = buildOidcBindEvent(pending.challenge, pending.identity);
        const result = await finishOidcBind(
          getBuzzRuntimeConfig().relayUrl,
          pending.challenge,
          event,
        );
        pending.managedIdentity = result.identity;
        pending.bound = true;
      }
      await clearPendingGitHubSignInState();
      // GitHub OAuth establishes the identity. Repository installation is a
      // separate, user-triggered action in the workspace and Room repo pickers.
      // Everything after the bind is recoverable in-app. Never report a false
      // sign-in failure after the durable identity is present.
      await clearPendingGitHubIdentity().catch(() => undefined);
      await markPersonNameOnboardingPending().catch(() => undefined);
      // Push registration is recoverable in-app. Once the key is saved, never
      // turn optional setup work into a false sign-in failure.
      await registerBuzzPushNotifications(pending.identity).catch(() => undefined);
      pendingBind.current = null;
      setStatus(nextOnboardingStatus('binding', 'bind_succeeded'));
      await continueAfterIdentity(pending.identity, pending.managedIdentity);
    } catch (error) {
      const normalized =
        error instanceof OidcBindError
          ? error
          : new OidcBindError(
              'storage_failed',
              error instanceof Error ? error.message : String(error),
              500,
            );
      const next = noticeForAuthError(normalized);
      if (!next.retryable && normalized.code !== 'identity_conflict') pendingBind.current = null;
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      setLoadingAction(null);
    }
  };

  useEffect(() => {
    if (!canSignIn) {
      setStatus('idle');
      return;
    }
    let alive = true;
    void (async () => {
      const initialUrl = await initialAuthUrl().catch(() => null);
      // A press already running in this process owns its own callback. This
      // screen is the one expo-router routed over it when that callback
      // arrived: it must neither spend the one-use ticket a second time nor
      // race the press into the app past the ceremony it is about to publish.
      if (isSignInInFlight()) return;
      const googleTicket = await resumeGoogleSignIn(initialUrl);
      if (googleTicket) {
        void funnelCallback('success');
        const identityId = await exchangeFunnelTicket(googleTicket, 'google');
        await clearPendingGoogleSignIn();
        if (alive) await enterAfterMonolithSignIn(identityId);
        return;
      }
      const savedIdentityId = await monolithSession.identityId();
      const challenge =
        (await resumeInitialGitHubSignIn(() => Promise.resolve(initialUrl), undefined, {
          signedIn: savedIdentityId !== null,
        })) ??
        (await recoverPendingGitHubBindChallenge()) ??
        (await loadPendingGitHubBindChallenge());
      if (challenge) {
        if (await isPendingGitHubReconnect()) {
          let result = 'success';
          try {
            await monolithSession.reconnectGitHubTicket(challenge.ticket);
          } catch (error) {
            result = error instanceof GitHubAccountMismatchError ? 'mismatch' : 'failed';
          }
          await clearPendingGitHubSignInState();
          if (alive)
            router.replace({
              pathname: '/beeline/settings',
              params: { githubReconnect: result },
            });
          return;
        }
        void funnelCallback('success');
        if (repositoryOnboarding) setStatus('binding');
        const identityId = await exchangeFunnelTicket(challenge.ticket);
        await clearPendingGitHubSignInState();
        if (alive) await enterAfterMonolithSignIn(identityId);
        return;
      }
      if (savedIdentityId) {
        if (alive) router.replace('/beeline/channels');
      }
    })()
      .catch((error: unknown) => {
        void funnelCallback('error','unknown');
        if (!alive) return;
        const next = noticeForAuthError(error);
        setNotice(next);
        setStatus(next.status);
      })
      .finally(() => {
        if (alive) setStatus((current) => (current === 'checking_device' ? 'idle' : current));
      });
    return () => {
      alive = false;
    };
  }, [canSignIn]);

  const handleGoogleSignIn = async () => {
    if (!canSignIn || !googleEnabled || loading) return;
    setLoadingAction('google');
    setStatus('opening_browser');
    clearOnboardingNotice();
    setNotice(null);
    markSignInInFlight(true);
    try {
      const funnelContext = await beginFunnelAttempt('google').catch(() => undefined);
      const ticket = await runGoogleSignIn({
        funnelContext,
        state: randomState(),
        recoveryToken: randomState(),
        openAuthSession: (url, redirect) =>
          openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect)),
        subscribeToUrls: subscribeToAuthUrls,
      });
      void funnelCallback('success');
      const identityId = await exchangeFunnelTicket(ticket, 'google');
      await clearPendingGoogleSignIn();
      await enterAfterMonolithSignIn(identityId);
    } catch (error) {
      const cancelled = error instanceof OidcBindError && ['browser_canceled', 'oidc_denied'].includes(error.code);
      void funnelCallback(cancelled ? 'cancelled' : 'error', cancelled ? undefined : 'unknown');
      const next = noticeForAuthError(
        error instanceof OidcBindError
          ? error
          : new OidcBindError('exchange_failed', 'Google sign-in could not finish. Try again.'),
      );
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      markSignInInFlight(false);
      setLoadingAction(null);
    }
  };

  const handleSignIn = async () => {
    if (!canSignIn) return;
    setLoadingAction('github');
    setStatus('opening_browser');
    clearOnboardingNotice();
    setNotice(null);
    markSignInInFlight(true);
    let startedState: string | undefined;
    try {
      const funnelContext=await beginFunnelAttempt('github').catch(()=>undefined);
      const runtime = getBuzzRuntimeConfig();
      const state = randomState();
      startedState = state;
      const challenge = await runResilientGitHubSignInSession({
        state,
        recoveryToken: randomState(),
        funnelContext,
        runtime,
        openAuthSession: (authorizationUrl, redirectUri) =>
          openAccountAuthSession(
            authorizationUrl,
            redirectUri,
            authSessionOptions(Platform.OS, redirectUri),
          ),
        subscribeToUrls: subscribeToAuthUrls,
      });
      void funnelCallback('success');
      if (repositoryOnboarding) setStatus('binding');
      const identityId = await exchangeFunnelTicket(challenge.ticket);
      await clearPendingGitHubSignInState();
      await enterAfterMonolithSignIn(identityId);
    } catch (error) {
      const cancelled=error instanceof OidcBindError && ['browser_canceled','github_denied','oidc_denied'].includes(error.code);
      void funnelCallback(cancelled?'cancelled':'error',cancelled?undefined:error instanceof OidcBindError && error.code==='offline'?'offline':'unknown');
      await cancelPendingGitHubSignIn(undefined, undefined, startedState).catch(() => undefined);
      const next = noticeForAuthError(error);
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      markSignInInFlight(false);
      setLoadingAction(null);
    }
  };

  const handleReplaceDeviceKey = async () => {
    const pending = pendingBind.current;
    if (!pending || loading) return;
    setLoadingAction('recover');
    clearOnboardingNotice();
    setNotice(null);
    try {
      if (pending.challenge.expires_at <= Math.floor(Date.now() / 1_000)) {
        throw new OidcBindError('ticket_expired', 'The recovery ticket expired', 410);
      }
      const event = buildOidcBindEvent(pending.challenge, pending.identity);
      const result = await recoverOidcBind(
        getBuzzRuntimeConfig().relayUrl,
        pending.challenge,
        event,
      );
      pending.managedIdentity = result.identity;
      pending.bound = true;
      await finishPendingBind(pending);
    } catch (error) {
      const next = noticeForAuthError(error);
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleNameContinue = async () => {
    if (!namingIdentity) return;
    const normalized = normalizeManagedHandle(nameInput);
    if (!normalized) {
      setNotice({
        status: 'bind_retry',
        title: "HANDLE NOT AVAILABLE",
        message: "Use 3–30 lowercase letters, numbers, or dashes.",
        retryable: false,
      });
      return;
    }
    setLoadingAction('name');
    setNotice(null);
    const clearOnboardingName = onboardingNameDraft.capture();
    try {
      const claim = await monolithPhoneOperation('claimManagedHandle', { handle: normalized });
      try {
        const client = namingClient ?? (await new BuzzRigTransport(namingIdentity).ensureClient());
        const current = await client
          .getGlobalPersonProfile(namingIdentity.publicKey)
          .catch(() => null);
        await client.setGlobalPersonProfile({
          name: claim.name,
          handle: claim.handle,
          avatar: current?.avatar,
        });
      } catch {
        // The authenticated server assignment is authoritative. Profile
        // publication is best-effort here and can reconcile on next launch.
      }
      clearOnboardingName();
      await savePreferredPersonName(namingIdentity.publicKey, claim.name).catch(() => undefined);
      await clearPersonNameOnboardingPending().catch(() => undefined);
      router.replace('/beeline/channels');
    } catch (error) {
      const taken = error instanceof Error && /already claimed/i.test(error.message);
      setNotice({
        status: 'bind_retry',
        title: taken
          ? "HANDLE ALREADY CLAIMED"
          : "HANDLE NOT CLAIMED",
        message: taken
          ? `@${normalized} belongs to someone else. Choose another handle.`
          : error instanceof Error
            ? error.message
            : String(error),
        retryable: false,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  const canRetryBind = notice?.retryable === true && pendingBind.current !== null;
  // Offline, the one action is the person's own retry; nothing retries for them.
  const signInLabel = notice?.status === 'offline' ? 'Try again' : 'Continue with GitHub';
  const desktopAuthSurface = isTauri();

  if (faceStep) {
    return (
      <View
        style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="onboarding-face-ceremony"
      >
        <YouStep
          currentFace={faceStep.face}
          handle={faceStep.handle}
          name={faceStep.name}
          editableIdentity
          provider={faceStep.provider}
          onConfirm={async ({ face, name, handle }) => {
            if (name !== undefined) await monolithPhoneOperation('updatePersonProfile', { name });
            if (handle !== undefined)
              await monolithPhoneOperation('claimManagedHandle', { handle });
            await monolithPhoneOperation('updateIdentityFace', { faceId: face });
          }}
          onEntered={() => {
            clearOnboardingFaceStep();
            router.replace('/beeline/channels');
          }}
          seed={faceStep.seed}
        />
      </View>
    );
  }

  if (namingIdentity) {
    const normalized = normalizeManagedHandle(nameInput);
    return (
      <View
        style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="onboarding-handle-ceremony"
      >
        <PixelGateReveal style={styles.namePanel}>
          <RoomListSectionHeader title={'IDENTITY · HANDLE CEREMONY'} inset="content" />
          <View style={styles.nameAvatar}>
            <IdentityMark
              kind="human"
              seed={namingIdentity.publicKey}
              name={(normalized ?? nameInput) || 'new identity'}
              size={82}
            />
          </View>
          <Text style={styles.nameTitle}>{"Choose your handle"}</Text>
          <Text style={styles.nameBody}>{"This name is bound to your key. It becomes your verified Beeline identity everywhere."}</Text>
          <HullDialogInput
            accessibilityLabel={"Choose your Beeline handle"}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={!loading}
            maxLength={30}
            onBlur={() => setNameFocused(false)}
            onChangeText={(value) => setNameInput(value.toLowerCase())}
            onFocus={() => setNameFocused(true)}
            onSubmitEditing={() => void handleNameContinue()}
            placeholder={"ada-labs"}
            placeholderTextColor={theme.buzz.textDisabled}
            returnKeyType="done"
            style={[styles.nameInput, nameFocused && styles.inputFocused]}
            testID="onboarding-handle-input"
            value={nameInput}
          />
          <Text style={styles.nameHandle}>
            {normalized ? `@${normalized}` : "3–30 · a–z · 0–9 · dash"}
          </Text>
          {notice && (
        <View accessibilityRole="alert" style={styles.noticePanel}>
          <Text style={styles.statusLabel}>◇ {notice.title}</Text>
          <Text style={styles.noticeText}>{notice.message}</Text>
        </View>
      )}
          <Button
            disabled={!normalized || loading}
            label={"Claim handle"}
            loading={loadingAction === 'name'}
            onPress={() => void handleNameContinue()}
            testID="onboarding-claim-handle"
          />
        </PixelGateReveal>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={[styles.brandSurface, desktopAuthSurface && styles.desktopBrandSurface]}>
        <BeelineMark size={desktopAuthSurface ? 156 : 112} shimmer />
        <Text
          style={desktopAuthSurface ? [styles.title, styles.desktopTitle] : styles.title}
          testID="onboarding-wordmark"
        >
          beeline<Text style={styles.titlePeriod}>.</Text>
        </Text>
        <Text style={styles.subtitle} testID="onboarding-tagline">
          workspace for all intelligence
        </Text>
      </View>

      {notice && (
        <View accessibilityRole="alert" style={styles.noticePanel}>
          <Text style={styles.statusLabel}>◇ {notice.title}</Text>
          <Text style={styles.noticeText}>{notice.message}</Text>
        </View>
      )}

      <View style={styles.actions}>
        {notice?.status === 'link_conflict' && pendingBind.current ? (
          <View style={styles.recoveryActions}>
            <Text style={styles.recoveryWarning}>
              Replacing the device key moves this GitHub link to your new key. Your Workspaces,
              Rooms, and repository approvals follow this account — agents and people you work with
              keep working with you, no re-invites.
            </Text>
            <Button
                label="Replace device key"
              loading={loadingAction === 'recover'}
              onPress={() => void handleReplaceDeviceKey()}
              disabled={loading}
              testID="onboarding-replace-device-key"
            />
          </View>
        ) : canRetryBind ? (
          <Button
            label="Retry device bind"
            loading={loadingAction === 'bind'}
            onPress={() => pendingBind.current && void finishPendingBind(pendingBind.current)}
            disabled={loading}
          />
        ) : canSignIn ? (
          <>
            {!googleEnabled && repositoryOnboarding ? <Text style={styles.subtitle} testID="onboarding-github-scope">Sign in and install Beeline on your personal GitHub account. Choose All repositories so Beeline can work on repos you create later.</Text> : null}
            <View>
              <Button
                label={signInLabel}
                labelStyle={Platform.OS === 'android' ? styles.signInLabel : undefined}
                variant={googleEnabled ? 'secondary' : undefined}
                testID="onboarding-github-sign-in"
                loading={loadingAction === 'github' || loadingAction === 'bind' || status === 'checking_device'}
                onPress={() => void handleSignIn()}
                disabled={loading || status === 'checking_device' || status === 'binding'}
              />
              {googleEnabled ? <Text style={styles.recommended}>Recommended</Text> : null}
            </View>
            {googleEnabled ? (
              <Button
                label="Continue with Google"
                variant="secondary"
                testID="onboarding-google-sign-in"
                loading={loadingAction === 'google'}
                disabled={loading || status === 'checking_device' || status === 'binding'}
                onPress={() => void handleGoogleSignIn()}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    recommended: {
      ...theme.buzz.type.sectionHead,
      color: theme.buzz.bgBase,
      backgroundColor: theme.buzz.accent,
      position: 'absolute',
      top: -theme.buzz.space.sm,
      right: theme.buzz.space.sm,
      paddingHorizontal: theme.buzz.space.xs,
      borderRadius: theme.buzz.radius,
    },
    container: {
      flex: 1,
      paddingHorizontal: 24,
      justifyContent: 'center',
      backgroundColor: groknight.bgVoid,
    },
    brandSurface: { alignItems: 'center', marginBottom: groknight.space.xl },
    desktopBrandSurface: { marginBottom: groknight.space.xl },
    title: {
      // Canonical brand family (theme prose voice, Space Grotesk) — the login
      // wordmark is a brand surface, not a logo-font exception.
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      fontSize: 28,
      lineHeight: 32,
      color: groknight.textPrimary,
      textAlign: 'center',
      // Android can undermeasure the bundled face's intrinsic Text width.
      width: Platform.OS === 'android' ? '100%' : undefined,
      marginTop: groknight.space.xs,
      marginBottom: 8,
    },
    desktopTitle: { transform: [{ scale: DESKTOP_WORDMARK_SCALE }], marginTop: groknight.space.sm },
    // The trailing period of the `beeline.` wordmark is the one brass glyph.
    // Same canonical family as the title it nests inside, per the typography
    // governor (every Text style names an app font).
    titlePeriod: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.accent,
    },
    // Canonical brand family on the login buttons' labels (theme prose voice).
    subtitle: {
      ...theme.buzz.type.body,
      maxWidth: 320,
      // Reserve the line's width so a notice-triggered layout cannot crop it.
      width: '100%',
      alignSelf: 'center',
      color: groknight.textSecondary,
      textAlign: 'center',
    },
    noticePanel: {
      width: '100%',
      maxWidth: 440,
      alignSelf: 'center',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
      padding: groknight.space.md,
      marginBottom: 16,
    },
    statusLabel: {
      ...theme.buzz.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.textPrimary,
      marginBottom: 4,
    },
    noticeText: {
      ...theme.buzz.type.body,
      color: groknight.textSecondary,
    },
    inputFocused: {
      borderWidth: INPUT_FOCUSED_BORDER_WIDTH,
      borderColor: groknight.focus,
      paddingHorizontal: groknight.space.md - (INPUT_FOCUSED_BORDER_WIDTH - INPUT_BORDER_WIDTH),
    },
    // Android undermeasures the bundled face; reserve only this sign-in label's width.
    signInLabel: { flexGrow: 1, textAlign: 'center' },
    actions: { width: '100%', maxWidth: 440, alignSelf: 'center', gap: groknight.space.sm },
    recoveryActions: { gap: groknight.space.sm },
    recoveryWarning: {
      ...theme.buzz.type.meta,
      color: groknight.textSecondary,
    },
    namePanel: { width: '100%', maxWidth: 420, alignSelf: 'center' },
    nameAvatar: { alignItems: 'center', marginTop: groknight.space.md, marginBottom: groknight.space.md },
    nameTitle: {
      ...theme.buzz.type.hero,
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
      textAlign: 'center',
    },
    nameBody: {
      ...theme.buzz.type.body,
      marginTop: groknight.space.sm,
      marginBottom: groknight.space.md,
      color: groknight.textSecondary,
      textAlign: 'center',
    },
    nameInput: {
      ...theme.buzz.type.bodyStrong,
      fontFamily: groknight.proseSemibold,
      minHeight: 52,
      borderWidth: 1,
      borderColor: groknight.border,
      borderRadius: 3,
      paddingHorizontal: groknight.space.md,
      color: groknight.textPrimary,
      backgroundColor: groknight.bgBase,
      textAlign: 'center',
    },
    nameHandle: {
      ...theme.buzz.type.machine,
      fontFamily: groknight.monoSemibold,
      marginTop: 8,
      marginBottom: groknight.space.md,
      color: groknight.textMuted,
      textAlign: 'center',
    },
  custodyNote: {
      ...theme.buzz.type.meta,
      marginTop: groknight.space.md,
      color: groknight.textMuted,
      textAlign: 'center',
    },
};
});
