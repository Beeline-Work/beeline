import React, { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import {
  clearBuzzIdentity,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import { clearBuzzLocalCache } from '@/buzz/local-cache';
import { groknight } from '@/buzz/groknight';
import { WORKSPACES_LABEL } from '@/buzz/vocabulary';
import { hairlineDivider, PixelGateReveal } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';

/**
 * The account settings hub — the single surface the Workspace rail's YOU
 * command opens. Every other entry point used to jump straight past it into
 * `settings/identity`, which left this screen, and the only sign-out in the
 * product, unreachable from the app's own chrome.
 *
 * It is built as an index, in the Room list's vocabulary: no row surfaces, one
 * hairline between rows, copy on the same three tones, and each row's mark
 * hanging in the right gutter.
 */
export default function BuzzSettings() {
  const insets = useSafeAreaInsets();
  const [confirmForget, setConfirmForget] = useState(false);
  const [githubInstallations, setGitHubInstallations] = useState<GitHubInstallationAccess[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()])
      .then(async ([identity, relayUrl]) => {
        if (!identity) return;
        const access = await new BuzzRigTransport(identity, relayUrl).workspaceGitHubAccess();
        if (!cancelled) setGitHubInstallations(access.installations);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
      {/* Chrome carries no surface of its own: the header is the same obsidian
          as the list below it, parted by one hairline. */}
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.headerMeta}>ACCOUNT · ALL {WORKSPACES_LABEL.toUpperCase()}</Text>
        </View>
      </View>

      <View style={styles.content}>
        <Text style={styles.sectionLabel}>IDENTITY</Text>
        <TouchableOpacity
          accessibilityLabel="Open My Settings"
          accessibilityRole="button"
          onPress={() => router.push('/buzz/settings/identity' as Href)}
          style={styles.settingsRow}
          testID="backup-key-setting"
        >
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>My Settings</Text>
            <Text style={styles.rowSubtitle}>Identity, notifications, sign-in, and key backup</Text>
          </View>
          <View style={styles.rowGutter}>
            <Text style={styles.rowChevron}>›</Text>
          </View>
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>CONNECTED ACCOUNTS</Text>
        {githubInstallations.map((installation) => (
          <TouchableOpacity
            accessibilityLabel={`Manage ${installation.accountLogin} on GitHub`}
            accessibilityRole="link"
            key={installation.installationId}
            onPress={() => void Linking.openURL(installation.manageUrl)}
            style={styles.settingsRow}
            testID={`github-installation-${installation.installationId}`}
          >
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>{installation.accountLogin}</Text>
              <Text style={styles.rowSubtitle}>
                {installation.status === 'active'
                  ? `${installation.repositoryCount} repositories`
                  : `${installation.status} · reconnect required`}
              </Text>
            </View>
            <View style={styles.rowGutter}>
              <Text style={styles.manageText}>MANAGE ↗</Text>
            </View>
          </TouchableOpacity>
        ))}
        {!githubInstallations.length && (
          <View style={styles.settingsRow} testID="github-installations-empty">
            <View style={styles.rowCopy}>
              <Text style={styles.rowSubtitle}>No GitHub accounts connected</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionLabel}>THIS DEVICE</Text>
        <TouchableOpacity
          accessibilityLabel={confirmForget ? 'Confirm sign out' : 'Sign out on this device'}
          accessibilityRole="button"
          onPress={() => void handleForget()}
          style={styles.settingsRow}
          testID="sign-out-setting"
        >
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>{confirmForget ? '! Confirm sign out' : 'Sign out'}</Text>
            <Text style={styles.rowSubtitle}>Remove this identity from this device</Text>
          </View>
          <View style={styles.rowGutter}>
            <Text style={styles.forgetGlyph}>⌫</Text>
          </View>
        </TouchableOpacity>

        {/* A destructive, non-repeating safety notice is one of the two things
            DESIGN.md still lets a box wrap. */}
        {confirmForget && (
          <View accessibilityRole="alert">
            <PixelGateReveal style={styles.confirmPanel}>
              <Text style={styles.confirmText}>
                This removes the local identity from this device. Continue only if your key is
                backed up.
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setConfirmForget(false)}
                style={styles.cancelButton}
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </PixelGateReveal>
          </View>
        )}
      </View>
    </View>
  );
}

const SCREEN_INSET = 16;
/** The same marginalia column the Room list reserves, so a settings row and a
 * Room row hang their trailing marks off one edge. */
const ROW_GUTTER_WIDTH = 46;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: groknight.bgTerminal },
  header: {
    minHeight: 64,
    paddingRight: SCREEN_INSET,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    ...hairlineDivider,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.default(), color: groknight.chrome, fontSize: 28, lineHeight: 32 },
  headerCopy: { flex: 1, minWidth: 0 },
  title: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 17,
    lineHeight: 22,
  },
  headerMeta: {
    ...Typography.mono(),
    marginTop: 2,
    color: groknight.ledgerGhost,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  content: { paddingBottom: 24 },
  sectionLabel: {
    ...Typography.mono('semiBold'),
    paddingHorizontal: SCREEN_INSET,
    paddingTop: 18,
    paddingBottom: 6,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.1,
  },
  /* An index row, not a card: no fill, no border, no radius — one hairline. */
  settingsRow: {
    minHeight: 64,
    paddingLeft: SCREEN_INSET,
    paddingRight: SCREEN_INSET,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    ...hairlineDivider,
  },
  rowCopy: { flex: 1, minWidth: 0 },
  rowGutter: { width: ROW_GUTTER_WIDTH, alignItems: 'flex-end' },
  /* The hub reads on the index's three tones: name brightest, its explanation
   * a step down, the gutter's mark ghosted. */
  rowTitle: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 15,
    lineHeight: 20,
  },
  rowSubtitle: {
    ...Typography.default(),
    marginTop: 3,
    color: groknight.ledgerQuiet,
    fontSize: 12,
    lineHeight: 16,
  },
  rowChevron: {
    ...Typography.default(),
    color: groknight.ledgerGhost,
    fontSize: 18,
    lineHeight: 20,
  },
  manageText: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 9,
  },
  forgetGlyph: {
    ...Typography.default(),
    color: groknight.ledgerGhost,
    fontSize: 15,
    lineHeight: 20,
  },
  confirmPanel: {
    marginTop: 14,
    marginHorizontal: SCREEN_INSET,
    padding: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: groknight.border,
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
