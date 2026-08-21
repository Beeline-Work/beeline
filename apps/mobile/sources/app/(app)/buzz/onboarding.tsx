/** Native GitHub-first onboarding. OAuth proves lookup only; the Nostr key remains device-held. */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { getRandomBytes } from 'expo-crypto';
import {
  fallbackPersonName,
  normalizePersonName,
  OidcBindError,
  personHandle,
  type BuzzClient,
  buildOidcBindEvent,
  finishOidcBind,
  recoverOidcBind,
  lookupRecovery,
  startGitHubBind,
  type Identity,
  type OidcBindChallenge,
} from '@beeline/buzz-client';
import {
  clearPendingGitHubIdentity,
  generateBuzzIdentity,
  importBuzzIdentity,
  loadBuzzIdentity,
  loadPendingGitHubIdentity,
  savePendingGitHubIdentity,
  saveBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import {
  canConfirmNewKeyBackup,
  canEnterWithNewKey,
  createNewKeyDraft,
  maskNsec,
  type NewKeyDraft,
} from '@/auth/new-key-onboarding';
import {
  clearOnboardingNotice,
  nextOnboardingStatus,
  noticeForAuthError,
  publishOnboardingNotice,
  subscribeToOnboardingNotices,
  waitForAuthCallback,
  type OnboardingNotice,
  type OnboardingStatus,
} from '@/auth/onboarding-state';
import { authSessionOptions } from '@/auth/auth-session';
import {
  clearPendingGitHubSignInState,
  githubSignInRedirectUri,
  loadPendingGitHubBindChallenge,
  persistGitHubSignInState,
  resumeGitHubSignInCallback,
  resumeInitialGitHubInstallation,
  resumeInitialGitHubSignIn,
} from '@/auth/github-auth-session';
import {
  clearPersonNameOnboardingPending,
  isPersonNameOnboardingPending,
  loadPreferredPersonName,
  markPersonNameOnboardingPending,
  publishPreferredPersonName,
  resolveOnboardingPersonName,
  savePreferredPersonName,
} from '@/buzz/person-name';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import {
  HullSurface,
  MonoButton,
  PixelGateReveal,
} from '@/components/buzz/MonoHull';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from '@/components/buzz/IdentityMark';

WebBrowser.maybeCompleteAuthSession();

interface PendingBind {
  challenge: OidcBindChallenge;
  identity: Identity;
  bound: boolean;
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

export default function BuzzOnboarding() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const pendingBind = useRef<PendingBind | null>(null);
  const existingIdentity = useRef<Identity | null>(null);
  const [nsecInput, setNsecInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState<OnboardingStatus>('checking_device');
  const [notice, setNotice] = useState<OnboardingNotice | null>(
    Platform.OS === 'web' ? WEB_NOTICE : null,
  );
  const [loadingAction, setLoadingAction] = useState<
    'github' | 'bind' | 'recover' | 'import' | 'name' | 'create' | 'enter' | null
  >(null);
  const [newKey, setNewKey] = useState<NewKeyDraft | null>(null);
  const [newKeyRevealed, setNewKeyRevealed] = useState(false);
  const [newKeyCopied, setNewKeyCopied] = useState(false);
  const [newKeySeen, setNewKeySeen] = useState(false);
  const [newKeyConfirmed, setNewKeyConfirmed] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [namingIdentity, setNamingIdentity] = useState<Identity | null>(null);
  const [namingClient, setNamingClient] = useState<BuzzClient | null>(null);
  const [namingCommunityId, setNamingCommunityId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const loading = loadingAction !== null;

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

  const continueAfterIdentity = async (identity: Identity) => {
    setStatus('entering_workspace');
    try {
      const transport = new BuzzRigTransport(identity, getBuzzRuntimeConfig().relayUrl);
      const client = await transport.ensureClient();
      const resolved = await resolveOnboardingPersonName(client, identity.publicKey);
      if (!resolved.needsPrompt) {
        await clearPersonNameOnboardingPending();
        router.replace('/buzz/channels');
        return;
      }
      setNamingClient(client);
      setNamingCommunityId(resolved.communityId);
      setNameInput(resolved.name);
      setNamingIdentity(identity);
      setNotice(null);
    } catch {
      const preferred = await loadPreferredPersonName(identity.publicKey);
      if (preferred) {
        await clearPersonNameOnboardingPending();
        router.replace('/buzz/channels');
        return;
      }
      setNamingClient(null);
      setNamingCommunityId(null);
      setNameInput(fallbackPersonName(identity.publicKey));
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
        await finishOidcBind(getBuzzRuntimeConfig().relayUrl, pending.challenge, event);
        pending.bound = true;
      }
      await clearPendingGitHubSignInState();
      // GitHub OAuth establishes the identity. Repository installation is a
      // separate, user-triggered action in the workspace and Room repo pickers.
      await saveBuzzIdentity(pending.identity);
      // Everything after the primary key save is recoverable in-app. Never
      // report a false sign-in failure after the durable identity is present.
      await clearPendingGitHubIdentity().catch(() => undefined);
      await markPersonNameOnboardingPending().catch(() => undefined);
      // Push registration is recoverable in-app. Once the key is saved, never
      // turn optional setup work into a false sign-in failure.
      await registerBuzzPushNotifications(pending.identity).catch(() => undefined);
      pendingBind.current = null;
      setStatus(nextOnboardingStatus('binding', 'bind_succeeded'));
      await continueAfterIdentity(pending.identity);
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
    if (Platform.OS === 'web') {
      setStatus('idle');
      return;
    }
    let alive = true;
    const relayUrl = getBuzzRuntimeConfig().relayUrl;
    void (async () => {
      const initialUrl = await Linking.getInitialURL().catch(() => null);
      const coldChallenge =
        (await resumeInitialGitHubSignIn(() => Promise.resolve(initialUrl))) ??
        (await loadPendingGitHubBindChallenge());
      if (coldChallenge) {
        if (!alive) return;
        setStatus('binding');
        const identity =
          (await loadBuzzIdentity()) ??
          (await loadPendingGitHubIdentity()) ??
          (await generateBuzzIdentity('buzzy-mobile', { persist: false }));
        await savePendingGitHubIdentity(identity);
        existingIdentity.current = identity;
        const pending: PendingBind = {
          challenge: coldChallenge,
          identity,
          bound: false,
        };
        pendingBind.current = pending;
        await finishPendingBind(pending);
        return;
      }

      const coldInstallation = await resumeInitialGitHubInstallation(() =>
        Promise.resolve(initialUrl),
      );
      if (coldInstallation) {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          throw new OidcBindError(
            'state_mismatch',
            'This GitHub installation has no device identity to return to.',
          );
        }
        existingIdentity.current = identity;
        if (alive) await continueAfterIdentity(identity);
        return;
      }

      const savedIdentity = await loadBuzzIdentity();
      const identity = savedIdentity ?? (await loadPendingGitHubIdentity());
      if (!identity) return;
      existingIdentity.current = identity;
      const links = await lookupRecovery(relayUrl, identity);
      if (!savedIdentity && links.length > 0) {
        await saveBuzzIdentity(identity);
        await clearPendingGitHubIdentity().catch(() => undefined);
        await markPersonNameOnboardingPending().catch(() => undefined);
        if (alive) await continueAfterIdentity(identity);
        return;
      }
      if (await isPersonNameOnboardingPending()) {
        if (alive && links.length > 0) await continueAfterIdentity(identity);
        return;
      }
      if (!alive || links.length === 0) return;
      await continueAfterIdentity(identity);
    })()
      .catch((error: unknown) => {
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
  }, []);

  const handleSignIn = async () => {
    if (Platform.OS === 'web') return;
    setLoadingAction('github');
    setStatus('opening_browser');
    clearOnboardingNotice();
    setNotice(null);
    try {
      const identity =
        existingIdentity.current ??
        (await loadPendingGitHubIdentity()) ??
        (await generateBuzzIdentity('buzzy-mobile', { persist: false }));
      await savePendingGitHubIdentity(identity);
      existingIdentity.current = identity;
      const state = randomState();
      const authBaseUrl = getBuzzRuntimeConfig().relayUrl;
      const redirectUri = githubSignInRedirectUri();
      const start = startGitHubBind(authBaseUrl, { redirectUri, state });
      await persistGitHubSignInState(state);
      const callbackUrl = await waitForAuthCallback({
        redirectUri: start.redirectUri,
        openAuthSession: () =>
          WebBrowser.openAuthSessionAsync(
            start.authorizationUrl,
            start.redirectUri,
            authSessionOptions(Platform.OS, start.redirectUri),
          ),
        subscribeToUrls: (listener) => Linking.addEventListener('url', ({ url }) => listener(url)),
      });
      setStatus(nextOnboardingStatus('opening_browser', 'callback_received'));
      const challenge = await resumeGitHubSignInCallback(callbackUrl);
      const pending = { challenge, identity, bound: false };
      pendingBind.current = pending;
      await finishPendingBind(pending);
    } catch (error) {
      await clearPendingGitHubSignInState();
      const next = noticeForAuthError(error);
      setStatus(next.status);
      setNotice(next);
      publishOnboardingNotice(next);
    } finally {
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
      await recoverOidcBind(getBuzzRuntimeConfig().relayUrl, pending.challenge, event);
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

  const handleImport = async () => {
    const trimmed = nsecInput.trim();
    if (!trimmed.startsWith('nsec1')) {
      setNotice({
        status: 'bind_retry',
        title: 'INVALID KEY',
        message: 'Paste a valid nsec1… secret key.',
        retryable: false,
      });
      return;
    }
    setLoadingAction('import');
    setNotice(null);
    let identitySaved = false;
    try {
      await markPersonNameOnboardingPending();
      const identity = await importBuzzIdentity(trimmed);
      identitySaved = true;
      await Promise.all([
        clearPendingGitHubIdentity().catch(() => undefined),
        clearPendingGitHubSignInState().catch(() => undefined),
      ]);
      await registerBuzzPushNotifications(identity);
      await continueAfterIdentity(identity);
    } catch (error) {
      if (!identitySaved) await clearPersonNameOnboardingPending();
      setNotice({
        status: 'bind_retry',
        title: 'IMPORT FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  const resetNewKey = () => {
    setNewKey(null);
    setNewKeyRevealed(false);
    setNewKeyCopied(false);
    setNewKeySeen(false);
    setNewKeyConfirmed(false);
  };

  const handleCreateKey = async () => {
    setLoadingAction('create');
    setNotice(null);
    try {
      const draft = await createNewKeyDraft();
      setNewKeyRevealed(false);
      setNewKeyCopied(false);
      setNewKeySeen(false);
      setNewKeyConfirmed(false);
      // Generated in memory only. Nothing reaches SecureStore until the
      // backup gate below opens.
      setNewKey(draft);
    } catch (error) {
      setNotice({
        status: 'bind_retry',
        title: 'KEY NOT CREATED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  const handleRevealNewKey = () => {
    const next = !newKeyRevealed;
    setNewKeyRevealed(next);
    if (next) setNewKeySeen(true);
  };

  const handleCopyNewKey = async () => {
    if (!newKey) return;
    try {
      await Clipboard.setStringAsync(newKey.nsec);
      setNewKeyCopied(true);
      setNewKeySeen(true);
      setTimeout(() => setNewKeyCopied(false), 1_200);
    } catch {
      setNotice({
        status: 'bind_retry',
        title: 'COPY FAILED',
        message: 'Beeline could not reach the clipboard. Reveal the key and copy it by hand.',
        retryable: false,
      });
    }
  };

  const handleEnterWithNewKey = async () => {
    if (!newKey) return;
    // Fail closed: the button is disabled without this, and it is re-checked
    // here so no other path can persist an unbacked key.
    if (!canEnterWithNewKey({ seen: newKeySeen, confirmed: newKeyConfirmed })) {
      setNotice({
        status: 'bind_retry',
        title: 'BACK UP YOUR KEY',
        message: 'Reveal or copy your secret key, then confirm you saved it.',
        retryable: false,
      });
      return;
    }
    setLoadingAction('enter');
    setNotice(null);
    let identitySaved = false;
    try {
      await markPersonNameOnboardingPending();
      await saveBuzzIdentity(newKey.identity);
      identitySaved = true;
      await Promise.all([
        clearPendingGitHubIdentity().catch(() => undefined),
        clearPendingGitHubSignInState().catch(() => undefined),
      ]);
      await registerBuzzPushNotifications(newKey.identity);
      const identity = newKey.identity;
      resetNewKey();
      await continueAfterIdentity(identity);
    } catch (error) {
      if (!identitySaved) await clearPersonNameOnboardingPending();
      setNotice({
        status: 'bind_retry',
        title: 'SETUP FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  const handleNameContinue = async () => {
    if (!namingIdentity) return;
    const normalized = normalizePersonName(nameInput);
    if (!normalized) {
      setNotice({
        status: 'bind_retry',
        title: 'NAME REQUIRED',
        message: 'Choose a name between 1 and 60 characters.',
        retryable: false,
      });
      return;
    }
    setLoadingAction('name');
    setNotice(null);
    try {
      if (namingClient && namingCommunityId) {
        await publishPreferredPersonName(
          namingClient,
          namingCommunityId,
          namingIdentity.publicKey,
          normalized,
        );
      } else {
        await savePreferredPersonName(namingIdentity.publicKey, normalized);
      }
      await clearPersonNameOnboardingPending();
      router.replace('/buzz/channels');
    } catch (error) {
      setNotice({
        status: 'bind_retry',
        title: 'NAME NOT SAVED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    } finally {
      setLoadingAction(null);
    }
  };

  const canRetryBind = notice?.retryable === true && pendingBind.current !== null;
  const signInLabel = 'Continue with GitHub';

  if (namingIdentity) {
    const normalized = normalizePersonName(nameInput);
    const handle = personHandle(
      normalized ?? fallbackPersonName(namingIdentity.publicKey),
      namingIdentity.publicKey,
    );
    return (
      <View
        style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="onboarding-person-name-step"
      >
        <PixelGateReveal style={styles.namePanel}>
          <Text style={styles.sectionLabel}>IDENTITY · YOUR WORKSPACE</Text>
          <View style={styles.nameAvatar}>
            <IdentityMark
              kind="human"
              seed={namingIdentity.publicKey}
              name={normalized ?? nameInput}
              size={82}
            />
          </View>
          <Text style={styles.nameTitle}>What should we call you?</Text>
          <Text style={styles.nameBody}>
            This is how people and Agents will recognize you. You can change it later in Identity
            settings.
          </Text>
          <TextInput
            accessibilityLabel="Your display name"
            autoCapitalize="words"
            autoCorrect={false}
            autoFocus
            editable={!loading}
            maxLength={60}
            onBlur={() => setNameFocused(false)}
            onChangeText={setNameInput}
            onFocus={() => setNameFocused(true)}
            onSubmitEditing={() => void handleNameContinue()}
            placeholder="Ada"
            placeholderTextColor={theme.buzz.textDisabled}
            returnKeyType="done"
            style={[styles.nameInput, nameFocused && styles.inputFocused]}
            testID="onboarding-person-name-input"
            value={nameInput}
          />
          <Text style={styles.nameHandle}>@{handle}</Text>
          {notice && (
            <View accessibilityRole="alert" style={styles.noticePanel}>
              <Text style={styles.statusLabel}>◇ {notice.title}</Text>
              <Text style={styles.noticeText}>{notice.message}</Text>
            </View>
          )}
          <MonoButton
            disabled={!normalized || loading}
            label="Enter Workspace"
            loading={loadingAction === 'name'}
            onPress={() => void handleNameContinue()}
            testID="onboarding-enter-workspace"
          />
        </PixelGateReveal>
      </View>
    );
  }

  if (newKey) {
    const backupConfirmable = canConfirmNewKeyBackup({ seen: newKeySeen });
    const canEnter = canEnterWithNewKey({ seen: newKeySeen, confirmed: newKeyConfirmed });
    return (
      <View
        style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="onboarding-new-key-step"
      >
        <PixelGateReveal style={styles.namePanel}>
          <Text style={styles.sectionLabel}>NEW KEY · BACK IT UP</Text>
          <View style={styles.nameAvatar}>
            <IdentityMark kind="human" seed={newKey.identity.publicKey} size={82} />
          </View>
          <Text style={styles.nameTitle}>Save your key</Text>
          <Text style={styles.nameBody}>
            This key is your Beeline identity. It lives only on this device and Beeline cannot reset
            it. Save it somewhere safe before you continue.
          </Text>

          <Text style={styles.sectionLabel}>PUBLIC · NPUB</Text>
          <HullSurface strength="code" style={styles.keyBox}>
            <Text selectable style={styles.keyText} testID="onboarding-new-key-npub">
              {newKey.npub}
            </Text>
          </HullSurface>

          <View style={styles.warning}>
            <Text style={styles.warningGlyph}>!</Text>
            <Text style={styles.warningText}>
              Anyone with the secret key controls this identity. Never share it.
            </Text>
          </View>

          <Text style={styles.sectionLabel}>SECRET · NSEC</Text>
          <HullSurface strength="code" style={styles.keyBox}>
            <Text
              selectable={newKeyRevealed}
              style={styles.keyText}
              testID="onboarding-new-key-nsec"
            >
              {newKeyRevealed ? newKey.nsec : maskNsec(newKey.nsec)}
            </Text>
          </HullSurface>
          <View style={styles.keyActions}>
            <TouchableOpacity
              accessibilityLabel={newKeyRevealed ? 'Hide secret key' : 'Reveal secret key'}
              accessibilityRole="button"
              onPress={handleRevealNewKey}
              style={styles.keyAction}
              testID="onboarding-new-key-reveal"
            >
              <Text style={styles.keyActionText}>{newKeyRevealed ? 'Hide' : 'Reveal'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel="Copy secret key"
              accessibilityRole="button"
              onPress={() => void handleCopyNewKey()}
              style={styles.keyAction}
              testID="onboarding-new-key-copy"
            >
              <Text style={styles.keyActionText}>{newKeyCopied ? '✓ COPIED' : 'Copy'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            accessibilityLabel="I saved my key"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: newKeyConfirmed, disabled: !backupConfirmable }}
            disabled={!backupConfirmable}
            onPress={() => {
              // Fail closed here too, not only via `disabled`: the gate must not
              // depend on a touchable honouring a prop.
              if (!backupConfirmable) return;
              setNewKeyConfirmed((value) => !value);
            }}
            style={styles.confirmRow}
            testID="onboarding-new-key-confirm"
          >
            <Text style={styles.confirmBox}>{newKeyConfirmed ? '[✓]' : '[ ]'}</Text>
            <Text style={[styles.confirmText, !backupConfirmable && styles.confirmTextIdle]}>
              I saved my key
            </Text>
          </TouchableOpacity>
          {!backupConfirmable && (
            <Text style={styles.confirmHint}>Reveal or copy the key to enable this.</Text>
          )}

          {notice && (
            <View accessibilityRole="alert" style={styles.noticePanel}>
              <Text style={styles.statusLabel}>◇ {notice.title}</Text>
              <Text style={styles.noticeText}>{notice.message}</Text>
            </View>
          )}

          <MonoButton
            disabled={!canEnter || loading}
            label="Enter Beeline"
            loading={loadingAction === 'enter'}
            onPress={() => void handleEnterWithNewKey()}
            testID="onboarding-new-key-enter"
          />
          <MonoButton
            disabled={loading}
            label="Discard this key"
            onPress={resetNewKey}
            style={styles.keyDiscard}
            variant="secondary"
            testID="onboarding-new-key-discard"
          />
        </PixelGateReveal>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.brandSurface}>
        <BeelineMark shimmer />
        <Text style={styles.title}>beeline</Text>
        <Text style={styles.subtitle}>workspace for all intelligence</Text>
      </View>

      {notice && (
        <View accessibilityRole="alert" style={styles.noticePanel}>
          <Text style={styles.statusLabel}>◇ {notice.title}</Text>
          <Text style={styles.noticeText}>{notice.message}</Text>
        </View>
      )}

      {showAdvanced && (
        <PixelGateReveal style={styles.importPanel}>
          <Text style={styles.sectionLabel}>ADVANCED · NEW NOSTR KEY</Text>
          <Text style={styles.keyGuide}>
            No key yet? Create one on this device. You back it up before entering Beeline.
          </Text>
          <View style={styles.importAction}>
            <MonoButton
              label="Create a new key"
              loading={loadingAction === 'create'}
              variant="secondary"
              onPress={() => void handleCreateKey()}
              disabled={loading}
              testID="onboarding-create-key"
            />
          </View>
          <View style={styles.advancedDivider} />
          <Text style={styles.sectionLabel}>ADVANCED · EXISTING NOSTR KEY</Text>
          <Text style={styles.keyGuide}>
            Your nostr key stays on this device and does not go to GitHub.
          </Text>
          <TextInput
            nativeID="buzz-secret-key"
            accessibilityLabel="Secret key"
            style={[styles.input, inputFocused && styles.inputFocused]}
            placeholder="nsec1…"
            placeholderTextColor={theme.buzz.textDisabled}
            value={nsecInput}
            onChangeText={setNsecInput}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={Platform.OS !== 'web'}
            testID="onboarding-secret-key"
            editable={!loading}
            onSubmitEditing={() => void handleImport()}
          />
          <View style={styles.importAction}>
            <MonoButton
              label="Import key"
              loading={loadingAction === 'import'}
              variant="secondary"
              onPress={() => void handleImport()}
              disabled={loading}
              testID="onboarding-import-key"
            />
          </View>
        </PixelGateReveal>
      )}

      <View style={styles.actions}>
        {!showAdvanced && notice?.status === 'link_conflict' && pendingBind.current ? (
          <View style={styles.recoveryActions}>
            <Text style={styles.recoveryWarning}>
              Replacing the device key disconnects GitHub from the old key. Your old Rooms, DMs,
              profile, and repository approvals do not transfer. If you backed up that key, import
              it from Advanced instead.
            </Text>
            <MonoButton
              label="Replace device key"
              loading={loadingAction === 'recover'}
              onPress={() => void handleReplaceDeviceKey()}
              disabled={loading}
              testID="onboarding-replace-device-key"
            />
          </View>
        ) : !showAdvanced && canRetryBind ? (
          <MonoButton
            label="Retry device bind"
            loading={loadingAction === 'bind'}
            onPress={() => pendingBind.current && void finishPendingBind(pendingBind.current)}
            disabled={loading}
          />
        ) : !showAdvanced && Platform.OS !== 'web' ? (
          <MonoButton
            label={signInLabel}
            loading={
              loadingAction === 'github' || loadingAction === 'bind' || status === 'checking_device'
            }
            onPress={() => void handleSignIn()}
            disabled={loading || status === 'checking_device' || status === 'binding'}
          />
        ) : null}
        <MonoButton
          label={showAdvanced ? 'Hide Advanced' : 'Advanced'}
          variant="secondary"
          onPress={() => {
            setShowAdvanced((value) => !value);
            setNotice(Platform.OS === 'web' ? WEB_NOTICE : null);
          }}
          disabled={loading}
          testID="onboarding-advanced"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    backgroundColor: groknight.bgVoid,
  },
  brandSurface: { alignItems: 'center', marginBottom: 28 },
  title: {
    ...Typography.logo(),
    fontSize: 28,
    lineHeight: 32,
    color: groknight.textPrimary,
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 8,
  },
  subtitle: {
    ...Typography.default(),
    maxWidth: 320,
    fontSize: 14,
    lineHeight: 20,
    color: groknight.textSecondary,
    textAlign: 'center',
  },
  noticePanel: {
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
    padding: 12,
    marginBottom: 16,
  },
  statusLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  noticeText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  importPanel: { marginBottom: 16 },
  sectionLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  keyGuide: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
  },
  input: {
    ...Typography.mono(),
    minHeight: 48,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
  },
  inputFocused: { borderWidth: 2, borderColor: groknight.focus, paddingHorizontal: 11 },
  importAction: { marginTop: 10 },
  actions: { gap: 10 },
  recoveryActions: { gap: 10 },
  recoveryWarning: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  custodyNote: {
    ...Typography.default(),
    marginTop: 18,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  advancedDivider: {
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    marginTop: 16,
    marginBottom: 16,
  },
  keyBox: { paddingHorizontal: 12, paddingVertical: 10, marginTop: 6, marginBottom: 10 },
  keyText: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 18,
  },
  keyActions: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  keyAction: {
    minHeight: 44,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyActionText: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 12,
  },
  keyDiscard: { marginTop: 10 },
  warning: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  warningGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 13,
    lineHeight: 18,
  },
  warningText: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  confirmBox: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  confirmText: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  confirmTextIdle: { color: groknight.textDisabled },
  confirmHint: {
    ...Typography.default(),
    marginBottom: 10,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  namePanel: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  nameAvatar: { alignItems: 'center', marginTop: 18, marginBottom: 18 },
  nameTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 26,
    lineHeight: 32,
    textAlign: 'center',
  },
  nameBody: {
    ...Typography.default(),
    marginTop: 10,
    marginBottom: 18,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  nameInput: {
    ...Typography.default('semiBold'),
    minHeight: 52,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 3,
    paddingHorizontal: 14,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 18,
    textAlign: 'center',
  },
  nameHandle: {
    ...Typography.mono('semiBold'),
    marginTop: 8,
    marginBottom: 18,
    color: groknight.textMuted,
    fontSize: 11,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  });
});
