/** Beeline onboarding — sign up with a new key or sign in with an existing nsec. */
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { generateBuzzIdentity, importBuzzIdentity } from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { Typography } from '@/constants/Typography';

export default function BuzzOnboarding() {
  const insets = useSafeAreaInsets();
  const [nsecInput, setNsecInput] = useState('');
  const [showSignIn, setShowSignIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const identity = await generateBuzzIdentity();
      await registerBuzzPushNotifications(identity);
      router.replace('/buzz/channels');
    } catch (err) {
      setError(`Could not generate and save a key: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    const trimmed = nsecInput.trim();
    if (!trimmed.startsWith('nsec1')) {
      setError('Paste a valid nsec1… secret key.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const identity = await importBuzzIdentity(trimmed);
      await registerBuzzPushNotifications(identity);
      router.replace('/buzz/channels');
    } catch (err) {
      setError(`Could not import and save this key: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Svg
        accessible
        accessibilityLabel="Beeline logo"
        width={112}
        height={112}
        viewBox="0 0 240 240"
        style={styles.logo}
      >
        <Path
          d="M 32 182 C 48 181, 58 180, 68 176 C 86 168, 60 143, 80 132 C 92 126, 104 138, 97 153 C 92 163, 77 164, 70 172 C 62 180, 82 185, 98 178 C 144 168, 176 148, 194 112 C 203 92, 208 66, 211 44"
          fill="none"
          stroke={groknight.accent}
          strokeWidth={8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      <Text style={styles.title}>beeline</Text>
      <Text style={styles.subtitle}>workspace for all intelligence</Text>

      {error && (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      )}

      {showSignIn && (
        <TextInput
          style={styles.input}
          placeholder="nsec1…"
          placeholderTextColor={groknight.dim}
          value={nsecInput}
          onChangeText={setNsecInput}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={Platform.OS !== 'web'}
          editable={!loading}
          onSubmitEditing={() => void handleImport()}
        />
      )}

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.secondaryButton, loading && styles.buttonDisabled]}
          onPress={() => {
            if (!showSignIn) {
              setShowSignIn(true);
              setError(null);
              return;
            }
            void handleImport();
          }}
          disabled={loading}
        >
          <Text style={styles.secondaryButtonText}>Sign in</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={() => void handleGenerate()}
          disabled={loading}
        >
          <Text style={styles.buttonText}>Sign up</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    backgroundColor: groknight.bgTerminal,
  },
  logo: {
    alignSelf: 'center',
    marginBottom: 4,
  },
  title: {
    ...Typography.default('semiBold'),
    fontSize: 28,
    fontWeight: '800',
    color: groknight.textPrimary,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    ...Typography.default(),
    fontSize: 13,
    color: groknight.muted,
    textAlign: 'center',
    marginBottom: 40,
    paddingHorizontal: 16,
    lineHeight: 18,
  },
  input: {
    ...Typography.default(),
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 4,
    padding: 12,
    fontSize: 13,
    color: groknight.textSecondary,
    backgroundColor: groknight.bgBase,
    marginBottom: 12,
  },
  actions: {
    gap: 10,
  },
  button: {
    backgroundColor: groknight.accent,
    paddingVertical: 12,
    borderRadius: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.accent,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    ...Typography.default('semiBold'),
    color: groknight.bgTerminal,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    paddingVertical: 12,
    borderRadius: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.borderActive,
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    ...Typography.default(),
    color: groknight.chrome,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
    textAlign: 'center',
  },
});
