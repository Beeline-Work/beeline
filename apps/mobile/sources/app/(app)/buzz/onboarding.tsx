/** Beeline onboarding: sign up with a new key or sign in with an existing nsec. */
import React, { useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { generateBuzzIdentity, importBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { MonoButton, PixelGateReveal } from '@/components/buzz/MonoHull';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { Typography } from '@/constants/Typography';

export default function BuzzOnboarding() {
  const insets = useSafeAreaInsets();
  const [nsecInput, setNsecInput] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [loadingAction, setLoadingAction] = useState<'generate' | 'import' | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = loadingAction !== null;

  const handleGenerate = async () => {
    setLoadingAction('generate');
    setError(null);
    try {
      const identity = await generateBuzzIdentity();
      await registerBuzzPushNotifications(identity);
      router.replace('/buzz/channels');
    } catch (err) {
      setError(`Could not generate and save a key: ${String(err)}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleImport = async () => {
    const trimmed = nsecInput.trim();
    if (!trimmed.startsWith('nsec1')) {
      setError('Paste a valid nsec1… secret key.');
      return;
    }
    setLoadingAction('import');
    setError(null);
    try {
      const identity = await importBuzzIdentity(trimmed);
      await registerBuzzPushNotifications(identity);
      router.replace('/buzz/channels');
    } catch (err) {
      setError(`Could not import and save this key: ${String(err)}`);
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.brandSurface}>
        <BeelineMark shimmer />
        <Text style={styles.title}>beeline</Text>
        <Text style={styles.subtitle}>workspace for all intelligence</Text>
      </View>

      {error && (
        <View accessibilityRole="alert" style={styles.errorPanel}>
          <Text style={styles.errorLabel}>! ERROR</Text>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {showSignIn && (
        <PixelGateReveal style={styles.importPanel}>
          <Text style={styles.sectionLabel}>SECRET KEY</Text>
          <Text style={styles.keyGuide}>
            Your nsec stays on this device. Beeline never publishes it.
          </Text>
          <TextInput
            nativeID="buzz-secret-key"
            accessibilityLabel="Secret key"
            style={[styles.input, inputFocused && styles.inputFocused, error && styles.inputError]}
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
        </PixelGateReveal>
      )}

      <View style={styles.actions}>
        <MonoButton
          label="Sign in"
          loading={loadingAction === 'import'}
          variant="secondary"
          onPress={() => {
            if (!showSignIn) {
              setShowSignIn(true);
              setError(null);
              return;
            }
            void handleImport();
          }}
          disabled={loading}
        />
        <MonoButton
          label="Sign up"
          loading={loadingAction === 'generate'}
          onPress={() => void handleGenerate()}
          disabled={loading}
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
  inputError: { borderColor: groknight.borderStrong },
  actions: { gap: 10 },
  errorPanel: {
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
    padding: 12,
    marginBottom: 16,
  },
  errorLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  errorText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
