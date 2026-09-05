import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, type Href } from 'expo-router';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import {
  clearBuzzIdentity,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import { clearPendingGitHubSignInState } from '@/auth/github-auth-session';
import { clearMobileSurfaceStorage } from '@/buzz/surface-storage';
import { WORKSPACES_LABEL } from '@/buzz/vocabulary';
import { PixelGateReveal, PixelLoader } from '@/components/buzz/MonoHull';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import { loadAppConfig } from '@/sync/appConfig';
import {
  createManualUpdateState,
  isManualUpdateBusy,
  manualUpdateButtonLabel,
  manualUpdateMessage,
  manualUpdateReducer,
} from './manual-update-state';

/**
 * The account settings hub — the single surface the Workspace rail's YOU
 * command opens. Every other entry point used to jump straight past it into
 * `settings/identity`, which left this screen, and the only sign-out in the
 * product, unreachable from the app's own chrome.
 *
 * It is the Members page's sibling: one list of `SettingsRow`s, small-caps
 * section heads, the three tones, and one trailing vocabulary per row — a
 * chevron to leave for something, a value to state one, a single action word
 * to act. Sign out is titled by its own verb in the danger tone, the shape the
 * Members page removes a member with; it was a backspace glyph in a gutter.
 */
export default function BuzzSettings() {
  const insets = useSafeAreaInsets();
  const [confirmForget, setConfirmForget] = useState(false);
  const [githubInstallations, setGitHubInstallations] = useState<GitHubInstallationAccess[]>([]);
  const manualUpdateRunning = useRef(false);
  const [manualUpdate, dispatchManualUpdate] = useReducer(
    manualUpdateReducer,
    Updates.isEnabled,
    createManualUpdateState,
  );
  const manualUpdateBusy = isManualUpdateBusy(manualUpdate);
  const manualUpdateStatus = manualUpdateMessage(manualUpdate);
  const release = loadAppConfig();
  // The release is the value a person wants off this row; the channel and the
  // running update id are machine detail and ride the one quiet line.
  const releaseValue = `${release.releaseVersion ?? 'development'}${
    release.releaseSha ? ` · ${release.releaseSha.slice(0, 12)}` : ''
  }`;
  // The update id is truncated the way the release sha already is: a machine
  // identifier at the precision a phone can read, not a UUID down three lines.
  const runningUpdateDetail = `${Updates.channel ?? 'not configured'} · ${
    Updates.updateId?.slice(0, 8) ?? 'embedded bundle'
  }`;

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
    await Promise.all([clearBuzzIdentity(), clearPendingGitHubSignInState()]);
    clearMobileSurfaceStorage();
    router.replace('/beeline/onboarding');
  }, [confirmForget]);

  const handleManualUpdate = useCallback(async () => {
    if (!Updates.isEnabled || manualUpdateRunning.current) return;

    manualUpdateRunning.current = true;
    dispatchManualUpdate({ type: 'start-check' });
    try {
      const update = await Updates.checkForUpdateAsync();
      if (!update.isAvailable) {
        dispatchManualUpdate({ type: 'latest' });
        return;
      }

      dispatchManualUpdate({ type: 'update-available' });
      const fetched = await Updates.fetchUpdateAsync();
      if (!fetched.isNew && !fetched.isRollBackToEmbedded) {
        throw new Error('expo-updates did not download the available update');
      }

      dispatchManualUpdate({ type: 'update-downloaded' });
      await Updates.reloadAsync();
    } catch {
      dispatchManualUpdate({ type: 'failed' });
    } finally {
      manualUpdateRunning.current = false;
    }
  }, []);

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
          <Text numberOfLines={1} style={styles.eyebrow}>
            Account · all {WORKSPACES_LABEL.toLowerCase()}
          </Text>
          <Text style={styles.title}>Settings</Text>
        </View>
      </View>

      <View style={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Identity</Text>
          <SettingsRow
            accessibilityLabel="Open My Settings"
            chevron="right"
            description="Identity, notifications, sign-in, and key backup"
            onPress={() => router.push('/beeline/settings/identity' as Href)}
            testID="backup-key-setting"
            title="My Settings"
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Connected GitHub accounts</Text>
          {githubInstallations.map((installation) => (
            <SettingsRow
              accessibilityLabel={`Manage ${installation.accountLogin} on GitHub`}
              accessibilityRole="link"
              action="Manage ↗"
              description={
                installation.status === 'active'
                  ? `${installation.repositoryCount} repositories`
                  : `${installation.status} · reconnect required`
              }
              key={installation.installationId}
              onPress={() => void Linking.openURL(installation.manageUrl)}
              testID={`github-installation-${installation.installationId}`}
              title={installation.accountLogin}
            />
          ))}
          {!githubInstallations.length && (
            <SettingsRow
              tone="quiet"
              testID="github-installations-empty"
              title="No GitHub accounts connected"
            />
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>This device</Text>
          <SettingsRow
            description={runningUpdateDetail}
            testID="ota-update-info"
            title="OTA update"
            value={releaseValue}
          />
          <SettingsRow
            accessibilityLabel={manualUpdateButtonLabel(manualUpdate)}
            description={manualUpdateStatus ?? undefined}
            disabled={!Updates.isEnabled || manualUpdateBusy}
            leading={
              manualUpdateBusy ? (
                <View testID="ota-update-progress">
                  <PixelLoader compact />
                </View>
              ) : undefined
            }
            onPress={() => void handleManualUpdate()}
            testID="ota-update-check"
            title={manualUpdateButtonLabel(manualUpdate)}
            tone="action"
          />
          <SettingsRow
            accessibilityLabel={confirmForget ? 'Confirm sign out' : 'Sign out on this device'}
            description={
              confirmForget
                ? 'Permanently erase this device’s identity key'
                : 'Remove this identity from this device'
            }
            tone="destructive"
            onPress={() => void handleForget()}
            testID="sign-out-setting"
            title={confirmForget ? 'Confirm sign out' : 'Sign out'}
          />
        </View>

        {/* A destructive, non-repeating safety notice is one of the two things
            DESIGN.md still lets a box wrap. */}
        {confirmForget && (
          <View accessibilityRole="alert">
            <PixelGateReveal style={styles.confirmPanel}>
              <Text style={styles.confirmText}>
                Signing out permanently erases this device’s copy of your identity key. Without an
                exported key, you cannot return as this identity. GitHub can link a new key later,
                but it cannot restore this identity’s Rooms, DMs, profile, or approvals.
              </Text>
              <TouchableOpacity
                accessibilityLabel="Back up key before signing out"
                accessibilityRole="button"
                onPress={() => router.push('/beeline/settings/identity' as Href)}
                style={styles.cancelButton}
                testID="backup-before-sign-out"
              >
                <Text style={styles.cancelText}>Back up key first</Text>
              </TouchableOpacity>
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

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    headerCopy: { flex: 1, minWidth: 0 },
    eyebrow: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    content: { padding: hull.space.md, gap: hull.layout.sectionGap },
    section: {},
    sectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      paddingRight: hull.space.sm,
      paddingBottom: hull.space.xs,
      color: hull.textMuted,
    },
    confirmPanel: {
      padding: hull.space.md,
      gap: hull.space.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    confirmText: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    cancelButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
    cancelText: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
  };
});
