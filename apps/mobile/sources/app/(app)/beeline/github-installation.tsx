import { useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/buzz/Button';
import { PageHeader } from '@/components/buzz/PageHeader';
import { completeGitHubInstallationRoute, githubInstallationReturnPath } from '@/auth/github-auth-session';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Keep progress and recoverable errors in Beeline after GitHub's consent page. */
function EnhancedGitHubInstallation() {
  useLatencyRouteFrame('/beeline/github-installation');
  const { installed } = useLocalSearchParams<{ installed?: string }>();
  const [returnPath, setReturnPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const path = await githubInstallationReturnPath();
        if (!path) throw new Error('This installation was not started on this device. Return to your Room and install Beeline again.');
        await completeGitHubInstallationRoute(installed);
        await monolithPhoneOperation('listGitHubRepositories', { refresh: true });
        if (alive) setReturnPath(path);
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { alive = false; };
  }, [installed, attempt]);
  if (returnPath) return <Redirect href={returnPath as Href} />;
  return <View style={styles.page} testID="github-installation-return">
    <PageHeader title={error ? 'GitHub needs another try' : 'Connecting GitHub'} />
    <Text style={styles.copy} accessibilityRole={error ? 'alert' : undefined}>
      {error ?? 'Checking your installation and loading the repositories Beeline can work in.'}
    </Text>
    {error ? <Button label="Retry" variant="secondary" onPress={() => setAttempt(value => value + 1)} /> : null}
  </View>;
}
const styles = StyleSheet.create(theme => ({
  page: { flex: 1, justifyContent: 'center', padding: theme.buzz.space.lg, gap: theme.buzz.space.md, backgroundColor: theme.buzz.bgTerminal },
  copy: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
}));

function LegacyGitHubInstallation() {
  useLatencyRouteFrame('/beeline/github-installation');
  const { installed } = useLocalSearchParams<{ installed?: string }>();
  const [returnPath, setReturnPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const path = await githubInstallationReturnPath().catch(() => null);
      if (path) await completeGitHubInstallationRoute(installed).catch(() => undefined);
      if (alive) setReturnPath(path ?? '/beeline/channels');
    })();
    return () => {
      alive = false;
    };
  }, [installed]);

  return returnPath ? <Redirect href={returnPath as Href} /> : null;
}

export default function GitHubInstallationFallback() {
  const enabled = useRepositoryOnboarding();
  if (enabled === null) return <View />;
  return enabled ? <EnhancedGitHubInstallation /> : <LegacyGitHubInstallation />;
}
