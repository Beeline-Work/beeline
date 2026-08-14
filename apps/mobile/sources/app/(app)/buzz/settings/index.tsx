import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { clearBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clearBuzzLocalCache } from '@/buzz/local-cache';
import { groknight } from '@/buzz/groknight';
import { HullSurface, PixelGateReveal } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';

export default function BuzzSettings() {
  const insets = useSafeAreaInsets();
  const [confirmForget, setConfirmForget] = useState(false);

  const handleForget = useCallback(async () => {
    if (!confirmForget) {
      setConfirmForget(true);
      return;
    }
    await clearBuzzIdentity();
    clearBuzzLocalCache();
    router.replace('/buzz/onboarding');
  }, [confirmForget]);

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <HullSurface strength="quiet" style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.headerMeta}>ACCOUNT · ALL WORKSPACES</Text>
        </View>
      </HullSurface>

      <View style={styles.content}>
        <Text style={styles.sectionLabel}>IDENTITY</Text>
        <TouchableOpacity
          accessibilityLabel="Open identity and backup settings"
          onPress={() => router.push('/buzz/settings/identity' as Href)}
          style={styles.settingsRow}
          testID="backup-key-setting"
        >
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>Identity & backup</Text>
            <Text style={styles.rowSubtitle}>Name, picture, and secret-key export</Text>
          </View>
          <Text style={styles.rowChevron}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityLabel={confirmForget ? 'Confirm sign out' : 'Sign out on this device'}
          onPress={() => void handleForget()}
          style={[styles.settingsRow, styles.destructiveRow]}
          testID="sign-out-setting"
        >
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>{confirmForget ? '! Confirm sign out' : 'Sign out'}</Text>
            <Text style={styles.rowSubtitle}>Remove this identity from this device</Text>
          </View>
          <Text style={styles.forgetGlyph}>⌫</Text>
        </TouchableOpacity>

        {confirmForget && (
          <View accessibilityRole="alert">
            <PixelGateReveal style={styles.confirmPanel}>
              <Text style={styles.confirmText}>
                This removes the local identity from this device. Continue only if your key is
                backed up.
              </Text>
              <TouchableOpacity onPress={() => setConfirmForget(false)} style={styles.cancelButton}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </PixelGateReveal>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 66,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.default(), color: groknight.chrome, fontSize: 30, lineHeight: 34 },
  headerCopy: { flex: 1, minWidth: 0, paddingRight: 44 },
  title: { ...Typography.default('semiBold'), color: groknight.textPrimary, fontSize: 18 },
  headerMeta: {
    ...Typography.mono('semiBold'),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.7,
  },
  content: { paddingTop: 24, paddingHorizontal: 18 },
  sectionLabel: {
    ...Typography.mono('semiBold'),
    marginBottom: 8,
    color: groknight.textMuted,
    fontSize: 10,
    letterSpacing: 0.8,
  },
  settingsRow: {
    minHeight: 68,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  destructiveRow: { borderBottomWidth: 1 },
  rowCopy: { flex: 1, minWidth: 0, paddingVertical: 12 },
  rowTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 14,
  },
  rowSubtitle: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  rowChevron: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
  forgetGlyph: { ...Typography.default(), color: groknight.steel, fontSize: 17 },
  confirmPanel: {
    marginTop: 12,
    padding: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  confirmText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  cancelButton: { minHeight: 44, marginTop: 5, alignSelf: 'flex-start', justifyContent: 'center' },
  cancelText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
  },
});
