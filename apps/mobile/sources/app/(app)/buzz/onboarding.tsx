/**
 * Buzz Onboarding — key generation or nsec paste.
 *
 * GrokNight alien-hull design.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  generateBuzzIdentity,
  importBuzzIdentity,
  getEffectiveRelayUrl,
  saveRelayUrl,
  DEFAULT_RELAY_URL,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { registerBuzzPushNotifications } from '@/push/buzz-push-registration';
import { Typography } from '@/constants/Typography';

export default function BuzzOnboarding() {
  const insets = useSafeAreaInsets();
  const [nsecInput, setNsecInput] = useState('');
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showKeyGuide, setShowKeyGuide] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load saved relay URL on mount
  useEffect(() => {
    let cancelled = false;
    void getEffectiveRelayUrl()
      .then((url) => {
        if (!cancelled) setRelayUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRelayUrl(DEFAULT_RELAY_URL);
          setError(`Unable to read secure storage: ${String(err)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      await saveRelayUrl(relayUrl.trim() || DEFAULT_RELAY_URL);
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
      await saveRelayUrl(relayUrl.trim() || DEFAULT_RELAY_URL);
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
      <Text style={styles.title}>buzzy</Text>
      <Text style={styles.subtitle}>Steer and review Agents from your phone.</Text>

      {error && (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>New key</Text>
        <TouchableOpacity style={styles.button} onPress={handleGenerate} disabled={loading}>
          <Text style={styles.buttonText}>{loading ? 'Generating…' : 'Generate new key'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Import existing key</Text>
        <TextInput
          style={styles.input}
          placeholder="nsec1…"
          placeholderTextColor={groknight.dim}
          value={nsecInput}
          onChangeText={setNsecInput}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={Platform.OS !== 'web'}
        />
        <TouchableOpacity
          style={[styles.secondaryButton, (!nsecInput.trim() || loading) && styles.buttonDisabled]}
          onPress={handleImport}
          disabled={!nsecInput.trim() || loading}
        >
          <Text style={styles.secondaryButtonText}>Import and continue</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ expanded: showKeyGuide }}
          onPress={() => setShowKeyGuide((value) => !value)}
          style={styles.guideToggle}
        >
          <Text style={styles.guideToggleText}>Where do I find my key?</Text>
        </TouchableOpacity>
        {showKeyGuide && (
          <Text style={styles.guideText}>
            Copy the nsec1… value from your Nostr app&apos;s identity or backup settings.
          </Text>
        )}
      </View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ expanded: showAdvanced }}
        style={styles.advancedToggle}
        onPress={() => setShowAdvanced((value) => !value)}
      >
        <Text style={[styles.advancedText, showAdvanced && styles.advancedTextActive]}>
          {showAdvanced ? '▾' : '›'} Advanced
        </Text>
      </TouchableOpacity>

      {showAdvanced && (
        <View style={styles.advancedPanel}>
          <Text style={styles.sectionTitle}>Relay URL</Text>
          <TextInput
            style={styles.input}
            placeholder={DEFAULT_RELAY_URL}
            placeholderTextColor={groknight.dim}
            value={relayUrl}
            onChangeText={setRelayUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.hint}>
            Change this only when connecting to a different Buzz relay.
          </Text>
        </View>
      )}
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
    marginBottom: 48,
    paddingHorizontal: 16,
    lineHeight: 18,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    ...Typography.default('semiBold'),
    fontSize: 11,
    fontWeight: '700',
    color: groknight.muted,
    marginBottom: 10,
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
    marginBottom: 10,
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
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 14,
    fontWeight: '600',
  },
  guideToggle: {
    alignSelf: 'flex-start',
    minHeight: 36,
    paddingVertical: 9,
  },
  guideToggleText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  guideText: {
    ...Typography.default(),
    color: groknight.muted,
    fontSize: 11,
    lineHeight: 17,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: groknight.border,
  },
  dividerText: {
    ...Typography.default(),
    marginHorizontal: 12,
    color: groknight.dim,
    fontSize: 11,
  },
  hint: {
    ...Typography.default(),
    fontSize: 12,
    color: groknight.muted,
    lineHeight: 16,
    marginTop: 4,
  },
  errorText: {
    ...Typography.default(),
    color: groknight.chrome,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
    textAlign: 'center',
  },
  advancedToggle: {
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  advancedText: {
    ...Typography.default('semiBold'),
    color: groknight.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  advancedTextActive: {
    color: groknight.textSecondary,
  },
  advancedPanel: {
    marginTop: 4,
    paddingTop: 14,
  },
});
