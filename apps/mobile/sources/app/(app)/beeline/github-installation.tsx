import { SettingsRow } from '@/components/buzz/SettingsRow';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet } from 'react-native-unistyles';
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import { PageHeader } from '@/components/buzz/PageHeader';
import { clearPendingGitHubInstallation, completeGitHubInstallationRoute, githubInstallationReturnPath } from '@/auth/github-auth-session';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Redirect first, then acknowledge consumption after the destination is handed off. */
function InstallationReturn({ path }: { path: string }) {
  useEffect(() => { void clearPendingGitHubInstallation().catch(() => undefined); }, [path]);
  return <Redirect href={path as Href} />;
}

/** Keep progress and recoverable errors in Beeline after GitHub's consent page. */
function EnhancedGitHubInstallation() {
  const desktopPageLayout = useDesktopPageLayout();
  useLatencyRouteFrame('/beeline/github-installation');
  const { installed, error: connectionError } = useLocalSearchParams<{ installed?: string; error?: string }>();
  const [returnPath, setReturnPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryPath, setRecoveryPath] = useState('/beeline/channels');
  useEffect(() => {
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const savedPath = await githubInstallationReturnPath();
        const path = savedPath ?? '/beeline/channels';
        if (alive) setRecoveryPath(path);
        if (Platform.OS !== 'web' && !savedPath) throw new Error('This installation was not started on this device. Return to your Room and install Beeline again.');
        if (Platform.OS !== 'web' && installed === '0' && connectionError) {
          if (alive) setReturnPath(`${path}${path.includes('?') ? '&' : '?'}githubConnectionError=${encodeURIComponent(connectionError)}`);
          return;
        }
        await completeGitHubInstallationRoute(installed, connectionError);
        await monolithPhoneOperation('listGitHubRepositories', { refresh: true });
        if (Platform.OS === 'web') WebBrowser.maybeCompleteAuthSession();
        if (alive) setReturnPath(path);
      } catch (reason) {
        if (alive) setError(appErrorCopy(reason));
      }
    })();
    return () => { alive = false; };
  }, [installed, connectionError]);
  if (returnPath) return <InstallationReturn path={returnPath} />;
  return <View style={[styles.page, desktopPageLayout && { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' }]} testID="github-installation-return">
    <PageHeader title={error ? 'GitHub needs another try' : 'Connecting GitHub'} />
    {error ? <SettingsRow title="Continue connecting GitHub"
      description="Return to your Room to refresh repositories and finish setup."
      action="Back to Room" onPress={() => setReturnPath(recoveryPath)} /> : <Text style={styles.copy}>
      Checking your installation and loading the repositories Beeline can work in.
    </Text>}
  </View>;
}
const styles = StyleSheet.create(theme => ({
  page: { flex: 1, justifyContent: 'center', padding: theme.buzz.space.lg, gap: theme.buzz.space.md, backgroundColor: theme.buzz.bgTerminal },
  copy: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
}));

function LegacyGitHubInstallation() {
  useLatencyRouteFrame('/beeline/github-installation');
  const { installed, error: connectionError } = useLocalSearchParams<{ installed?: string; error?: string }>();
  const [returnPath, setReturnPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const path = await githubInstallationReturnPath().catch(() => null);
      if (path) await completeGitHubInstallationRoute(installed).catch(() => undefined);
      if (alive) setReturnPath(path && installed === '0' && connectionError ? `${path}${path.includes('?') ? '&' : '?'}githubConnectionError=${encodeURIComponent(connectionError)}` : path ?? '/beeline/channels');
    })();
    return () => {
      alive = false;
    };
  }, [installed, connectionError]);

  return returnPath ? <InstallationReturn path={returnPath} /> : null;
}

export default function GitHubInstallationFallback() {
  const enabled = useRepositoryOnboarding();
  if (enabled === null) return <View />;
  return enabled ? <EnhancedGitHubInstallation /> : <LegacyGitHubInstallation />;
}
