import React, { useEffect, useState } from 'react';
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import {
  completeGitHubInstallationRoute,
  githubInstallationReturnPath,
} from '@/auth/github-auth-session';

/** Return a cold-started GitHub App installation to the picker that launched it. */
export default function GitHubInstallationFallback() {
  const { installed } = useLocalSearchParams<{ installed?: string }>();
  const [returnPath, setReturnPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const path = await githubInstallationReturnPath().catch(() => null);
      if (path) await completeGitHubInstallationRoute(installed).catch(() => undefined);
      if (alive) setReturnPath(path ?? '/buzz/channels');
    })();
    return () => {
      alive = false;
    };
  }, [installed]);

  return returnPath ? <Redirect href={returnPath as Href} /> : null;
}
