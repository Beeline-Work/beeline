import { useCallback, useEffect } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import { authSessionOptions } from '@/auth/auth-session';
import {
  githubRepositoryRefreshFeedback,
  resumeInitialGitHubInstallation,
  runGitHubInstallationSession,
  type GitHubRepositoryRefreshPhase,
} from '@/auth/github-auth-session';

export function githubInstallationHostBindings() {
  return {
    openAuthSession: (installationUrl: string, redirectUri: string) =>
      WebBrowser.openAuthSessionAsync(
        installationUrl,
        redirectUri,
        authSessionOptions(Platform.OS, redirectUri),
      ),
    subscribeToUrls: (listener: (url: string) => void) =>
      Linking.addEventListener('url', ({ url }) => listener(url)),
    subscribeToAppState: (listener: (state: string) => void) =>
      AppState.addEventListener('change', listener),
  };
}

export async function runHostGitHubInstallationSession(input: {
  returnPath: string;
  startInstallation: () => Promise<string>;
  refreshRepositories: () => Promise<void>;
  onRefreshPhase: (phase: GitHubRepositoryRefreshPhase) => void;
}): Promise<string | null> {
  return runGitHubInstallationSession({
    ...input,
    ...githubInstallationHostBindings(),
  });
}

/**
 * Shared GitHub App install session + cold-start resume for the New Room
 * picker and the Room picker. Both surfaces must open the picker they
 * launched from after Android kills the app during the GitHub browser session.
 */
export function useGitHubInstallationSession({
  ready,
  returnPath,
  startInstallation,
  refreshRepositories,
  onError,
  onNotice,
  onColdResume,
}: {
  ready: boolean;
  returnPath: string;
  startInstallation: (installationId?: number) => Promise<string>;
  refreshRepositories: () => Promise<void>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onColdResume: () => void | Promise<void>;
}): {
  handleAddGitHubAccount: () => Promise<void>;
  handleManageGitHubInstallation: (
    installation: Pick<GitHubInstallationAccess, 'installationId'>,
  ) => Promise<void>;
} {
  const handleRepositoryRefreshPhase = useCallback(
    (phase: GitHubRepositoryRefreshPhase) => {
      const feedback = githubRepositoryRefreshFeedback(phase);
      onNotice(feedback.notice);
      onError(feedback.error);
    },
    [onError, onNotice],
  );

  const runSession = useCallback(
    async (installationId?: number) => {
      if (!ready) return;
      onError(null);
      onNotice(null);
      try {
        await runHostGitHubInstallationSession({
          returnPath,
          startInstallation: () => startInstallation(installationId),
          refreshRepositories,
          onRefreshPhase: handleRepositoryRefreshPhase,
        });
      } catch (err) {
        onError(`Could not connect GitHub: ${String(err)}`);
      }
    },
    [
      handleRepositoryRefreshPhase,
      onError,
      onNotice,
      ready,
      refreshRepositories,
      returnPath,
      startInstallation,
    ],
  );

  const handleAddGitHubAccount = useCallback(async () => {
    await runSession();
  }, [runSession]);

  const handleManageGitHubInstallation = useCallback(
    async (installation: Pick<GitHubInstallationAccess, 'installationId'>) => {
      await runSession(installation.installationId);
    },
    [runSession],
  );

  useEffect(() => {
    if (!ready) return;
    void resumeInitialGitHubInstallation(() => Linking.getInitialURL())
      .then(async (completed) => {
        if (!completed) return;
        await onColdResume();
        await refreshRepositories();
      })
      .catch((err) => onError(`Could not connect GitHub: ${String(err)}`));
  }, [onColdResume, onError, ready, refreshRepositories]);

  return { handleAddGitHubAccount, handleManageGitHubInstallation };
}
