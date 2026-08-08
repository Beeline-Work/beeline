/**
 * Buzz Onboarding — key generation or nsec paste.
 *
 * GrokNight Terminal design.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  generateBuzzIdentity,
  importBuzzIdentity,
  getEffectiveRelayUrl,
  saveRelayUrl,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

export default function BuzzOnboarding() {
  const insets = useSafeAreaInsets();
  const [nsecInput, setNsecInput] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [loading, setLoading] = useState(false);

  // Load saved relay URL on mount
  useState(() => {
    getEffectiveRelayUrl().then(setRelayUrl);
  });

  const handleGenerate = async () => {
    setLoading(true);
    try {
      await saveRelayUrl(relayUrl.trim() || 'https://buzz.trustysquire.ai');
      await generateBuzzIdentity();
      router.replace('/buzz/channels');
    } catch (err) {
      Alert.alert('Error', String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    const trimmed = nsecInput.trim();
    if (!trimmed.startsWith('nsec1')) {
      Alert.alert('Invalid key', 'Paste an nsec1… secret key');
      return;
    }
    setLoading(true);
    try {
      await saveRelayUrl(relayUrl.trim() || 'https://buzz.trustysquire.ai');
      await importBuzzIdentity(trimmed);
      router.replace('/buzz/channels');
    } catch (err) {
      Alert.alert('Import failed', String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Text style={styles.title}>buzzy</Text>
      <Text style={styles.subtitle}>
        Join a channel with your Nostr key to watch an agent work.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>new key</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={handleGenerate}
          disabled={loading}
        >
          <Text style={styles.buttonText}>
            {loading ? 'generating…' : 'generate new key'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>import existing key</Text>
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
          style={[
            styles.button,
            (!nsecInput.trim() || loading) && styles.buttonDisabled,
          ]}
          onPress={handleImport}
          disabled={!nsecInput.trim() || loading}
        >
          <Text style={styles.buttonText}>import & continue</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Relay URL</Text>
        <TextInput
          style={styles.input}
          placeholder="https://buzz.trustysquire.ai"
          placeholderTextColor="#888"
          value={relayUrl}
          onChangeText={setRelayUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.hint}>
          Address of the Buzz relay your phone connects to. Change this if your
          relay is elsewhere (e.g. http://10.0.2.2:3010 for emulator → host).
        </Text>
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
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: groknight.textPrimary,
    textAlign: 'center',
    marginBottom: 8,
    fontFamily: mono,
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 13,
    color: groknight.muted,
    textAlign: 'center',
    marginBottom: 48,
    paddingHorizontal: 16,
    fontFamily: mono,
    lineHeight: 18,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: groknight.muted,
    marginBottom: 10,
    letterSpacing: 0.8,
    fontFamily: mono,
  },
  input: {
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 4,
    padding: 12,
    fontSize: 13,
    color: groknight.textSecondary,
    backgroundColor: groknight.bgBase,
    marginBottom: 10,
    fontFamily: mono,
  },
  button: {
    backgroundColor: groknight.bgHighlight,
    paddingVertical: 12,
    borderRadius: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.border,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: groknight.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: mono,
    letterSpacing: 0.3,
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
    marginHorizontal: 12,
    color: groknight.dim,
    fontSize: 11,
    fontFamily: mono,
  },
  hint: {
    fontSize: 12,
    color: '#666',
    lineHeight: 16,
    marginTop: 4,
  },
});