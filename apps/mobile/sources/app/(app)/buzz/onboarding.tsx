/** Native Google-first onboarding. OAuth proves lookup only; the Nostr key remains device-held. */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { getRandomBytes } from 'expo-crypto';
import {
  OidcBindError,
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
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { groknight } from '@/buzz/groknight';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { MonoButton, PixelGateReveal } from '@/components/buzz/MonoHull';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { Typography } from '@/constants/Typography';

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
  const [loadingAction, setLoadingAction] = useState<'google' | 'bind' | 'import' | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const loading = loadingAction !== null;

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
        const links = await lookupRecovery(getBuzzRuntimeConfig().relayUrl, identity);
        if (!alive || links.length === 0) return;
        setStatus('entering_workspace');
        router.replace('/buzz/channels');
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
      await saveBuzzIdentity(pending.identity);
      await registerBuzzPushNotifications(pending.identity);
      pendingBind.current = null;
      setStatus(nextGoogleOnboardingStatus('binding', 'bind_succeeded'));
      router.replace('/buzz/channels');
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
      router.replace('/buzz/channels');
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
          WebBrowser.openAuthSessionAsync(start.authorizationUrl, start.redirectUri, {
            preferUniversalLinks: start.redirectUri.startsWith('https://'),
          }),
        subscribeToUrls: (listener) =>
          Linking.addEventListener('url', ({ url }) => listener(url)),
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
    try {
      const identity = await importBuzzIdentity(trimmed);
      await registerBuzzPushNotifications(identity);
      router.replace('/buzz/channels');
    } catch (error) {
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

  const canRetryBind = notice?.retryable === true && pendingBind.current !== null;
  const googleLabel = status === 'existing_device' ? 'Open Workspace' : 'Continue with Google';

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
            Import bypasses Google. Your nsec stays on this device.
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
            />
          </View>
        </PixelGateReveal>
      )}

      <View style={styles.actions}>
        {canRetryBind ? (
          <MonoButton
            label="Retry device bind"
            loading={loadingAction === 'bind'}
            onPress={() => pendingBind.current && void finishPendingBind(pendingBind.current)}
            disabled={loading}
          />
        ) : Platform.OS !== 'web' ? (
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
        />
      </View>

      <Text style={styles.custodyNote}>
        Google cannot sign messages, join Rooms, grant roles, or approve merges.
      </Text>
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
});
