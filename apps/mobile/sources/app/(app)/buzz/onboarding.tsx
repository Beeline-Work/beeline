/** Native Google-first onboarding. OAuth proves lookup only; the Nostr key remains device-held. */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
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
  lookupRecovery,
  parseOidcBindCallback,
  startOidcBind,
  type Identity,
  type OidcBindChallenge,
} from '@beeline/buzz-client';
import {
  generateBuzzIdentity,
  importBuzzIdentity,
  loadBuzzIdentity,
  saveBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import {
  nextGoogleOnboardingStatus,
  noticeForOidcError,
  waitForGoogleAuthCallback,
  type GoogleOnboardingNotice,
  type GoogleOnboardingStatus,
} from '@/auth/google-onboarding-state';
import { googleAuthSessionOptions } from '@/auth/google-auth-session';
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
import { groknight } from '@/buzz/groknight';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { MonoButton, PixelGateReveal } from '@/components/buzz/MonoHull';
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

const WEB_NOTICE: GoogleOnboardingNotice = {
  status: 'idle',
  title: 'NATIVE ONLY',
  message:
    'Continue with Google is available in the Android and iOS app. Web key storage is not hardened for this flow.',
  retryable: false,
};

export default function BuzzOnboarding() {
  const insets = useSafeAreaInsets();
  const pendingBind = useRef<PendingBind | null>(null);
  const existingIdentity = useRef<Identity | null>(null);
  const [nsecInput, setNsecInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState<GoogleOnboardingStatus>('checking_device');
  const [notice, setNotice] = useState<GoogleOnboardingNotice | null>(
    Platform.OS === 'web' ? WEB_NOTICE : null,
  );
  const [loadingAction, setLoadingAction] = useState<'google' | 'bind' | 'import' | 'name' | null>(
    null,
  );
  const [inputFocused, setInputFocused] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [namingIdentity, setNamingIdentity] = useState<Identity | null>(null);
  const [namingClient, setNamingClient] = useState<BuzzClient | null>(null);
  const [namingCommunityId, setNamingCommunityId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const loading = loadingAction !== null;

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

  useEffect(() => {
    if (Platform.OS === 'web') {
      setStatus('idle');
      return;
    }
    let alive = true;
    void loadBuzzIdentity()
      .then(async (identity) => {
        if (!identity) return;
        existingIdentity.current = identity;
        if (await isPersonNameOnboardingPending()) {
          if (alive) await continueAfterIdentity(identity);
          return;
        }
        const links = await lookupRecovery(getBuzzRuntimeConfig().relayUrl, identity);
        if (!alive || links.length === 0) return;
        await continueAfterIdentity(identity);
      })
      .catch((error: unknown) => {
        if (alive && error instanceof OidcBindError && error.code === 'offline') {
          setNotice(noticeForOidcError(error));
          setStatus('offline');
        }
      })
      .finally(() => {
        if (alive) setStatus((current) => (current === 'checking_device' ? 'idle' : current));
      });
    return () => {
      alive = false;
    };
  }, []);

  const finishPendingBind = async (pending: PendingBind) => {
    setLoadingAction('bind');
    setStatus('binding');
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
      // The key enters SecureStore only after the server confirms this exact pubkey.
      await markPersonNameOnboardingPending();
      await saveBuzzIdentity(pending.identity);
      await registerBuzzPushNotifications(pending.identity);
      pendingBind.current = null;
      setStatus(nextGoogleOnboardingStatus('binding', 'bind_succeeded'));
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
      const next = noticeForOidcError(normalized);
      if (!next.retryable) pendingBind.current = null;
      setStatus(next.status);
      setNotice(next);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleGoogle = async () => {
    if (Platform.OS === 'web') return;
    if (status === 'existing_device') {
      if (existingIdentity.current) await continueAfterIdentity(existingIdentity.current);
      return;
    }
    setLoadingAction('google');
    setStatus('opening_browser');
    setNotice(null);
    try {
      const state = randomState();
      const authBaseUrl = getBuzzRuntimeConfig().relayUrl;
      const authOrigin = new URL(authBaseUrl);
      const redirectUri =
        authOrigin.protocol === 'https:'
          ? `${authOrigin.origin}/auth/oidc/mobile-callback`
          : Linking.createURL('buzz/oidc-callback');
      const start = startOidcBind(authBaseUrl, { redirectUri, state });
      const callbackUrl = await waitForGoogleAuthCallback({
        redirectUri: start.redirectUri,
        openAuthSession: () =>
          WebBrowser.openAuthSessionAsync(
            start.authorizationUrl,
            start.redirectUri,
            googleAuthSessionOptions(Platform.OS, start.redirectUri),
          ),
        subscribeToUrls: (listener) => Linking.addEventListener('url', ({ url }) => listener(url)),
      });
      setStatus(nextGoogleOnboardingStatus('opening_browser', 'callback_received'));
      const challenge = parseOidcBindCallback(callbackUrl, state);
      // Preserve upgraded users' existing device-held identity; only first-time
      // devices create a candidate key after Google proof succeeds.
      const identity =
        existingIdentity.current ??
        (await generateBuzzIdentity('buzzy-mobile', { persist: false }));
      const pending = { challenge, identity, bound: false };
      pendingBind.current = pending;
      await finishPendingBind(pending);
    } catch (error) {
      const next = noticeForOidcError(error);
      setStatus(next.status);
      setNotice(next);
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
  const googleLabel = status === 'existing_device' ? 'Open Workspace' : 'Continue with Google';

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
            placeholderTextColor={groknight.textDisabled}
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
          <Text style={styles.sectionLabel}>ADVANCED · EXISTING NOSTR KEY</Text>
          <Text style={styles.keyGuide}>
            Your nostr key stays on this device and does not go to Google.
          </Text>
          <TextInput
            nativeID="buzz-secret-key"
            accessibilityLabel="Secret key"
            style={[styles.input, inputFocused && styles.inputFocused]}
            placeholder="nsec1…"
            placeholderTextColor={groknight.textDisabled}
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
        {!showAdvanced && canRetryBind ? (
          <MonoButton
            label="Retry device bind"
            loading={loadingAction === 'bind'}
            onPress={() => pendingBind.current && void finishPendingBind(pendingBind.current)}
            disabled={loading}
          />
        ) : !showAdvanced && Platform.OS !== 'web' ? (
          <MonoButton
            label={googleLabel}
            loading={
              loadingAction === 'google' || loadingAction === 'bind' || status === 'checking_device'
            }
            onPress={() => void handleGoogle()}
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

const styles = StyleSheet.create({
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
  custodyNote: {
    ...Typography.default(),
    marginTop: 18,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    letterSpacing: 0.2,
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
