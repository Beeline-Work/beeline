/**
 * Buzz Onboarding — key generation or nsec paste.
 *
 * Dev-grade UI: a text field for pasting nsec1… and a "Generate new key" button.
 * On success, persists the identity and navigates to the channel list.
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
} from '@/auth/buzz-identity-storage';

export default function BuzzOnboarding() {
  const insets = useSafeAreaInsets();
  const [nsecInput, setNsecInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
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
      <Text style={styles.title}>Buzzy</Text>
      <Text style={styles.subtitle}>
        Join a channel with your Nostr key to watch an agent work.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>New key</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={handleGenerate}
          disabled={loading}
        >
          <Text style={styles.buttonText}>
            {loading ? 'Generating…' : 'Generate new key'}
          </Text>
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
          placeholderTextColor="#888"
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
          <Text style={styles.buttonText}>Import & Continue</Text>
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
    backgroundColor: '#000',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#aaa',
    textAlign: 'center',
    marginBottom: 48,
    paddingHorizontal: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#fff',
    backgroundColor: '#111',
    marginBottom: 12,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  button: {
    backgroundColor: '#0a84ff',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#333',
  },
  dividerText: {
    marginHorizontal: 12,
    color: '#666',
    fontSize: 14,
  },
});