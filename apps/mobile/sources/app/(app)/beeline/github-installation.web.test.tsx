// @vitest-environment jsdom
import React, { act } from 'react';
// @ts-expect-error react-dom has no declarations in this workspace.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mocks = vi.hoisted(() => ({ operation: vi.fn(async () => ({})) }));
vi.mock('@/buzz/onboarding-rollout', () => ({ useRepositoryOnboarding: () => true }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mocks.operation }));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `${window.location.origin}/${path}` }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/components/buzz/PageHeader', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/components/buzz/Button', () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => <button onClick={onPress}>{label}</button>,
}));
vi.mock('expo-web-browser', async () => {
  const { default: browser } = await import('expo-web-browser/src/ExpoWebBrowser.web');
  return { maybeCompleteAuthSession: () => browser.maybeCompleteAuthSession({}) };
});
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => Object.fromEntries(new URLSearchParams(window.location.search)),
  Redirect: ({ href }: { href: string }) => {
    React.useEffect(() => { window.history.replaceState(null, '', href); }, [href]);
    return <p>Returned to {href}</p>;
  },
}));

import GitHubInstallation from './github-installation';
import { githubInstallationReturnPath, resumeInitialGitHubInstallation, persistGitHubInstallationReturnPath, runGitHubInstallationSession } from '@/auth/github-auth-session';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/beeline/github-installation?installed=1');
  Object.defineProperty(window, 'opener', { configurable: true, value: null });
  mocks.operation.mockReset().mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function loadLanding() {
  await act(async () => { root.render(<GitHubInstallation />); });
}

it('GH-WEB-1: a successful landing with the pending key cleared refreshes and visibly returns to channels', async () => {
  await AsyncStorage.removeItem('buzzy.github-installation-return.v1');
  await loadLanding();
  // An old landing remains stuck even after pressing Retry.
  const retry = container.querySelector('button');
  if (retry) await act(async () => { retry.click(); });
  expect(container.textContent).toBe('Returned to /beeline/channels');
  expect(mocks.operation).toHaveBeenCalledWith('listGitHubRepositories', { refresh: true });
  expect(window.location.pathname).toBe('/beeline/channels');
});

it('keeps the Room destination when the opener dismisses before the successful landing arrives', async () => {
  await expect(runGitHubInstallationSession({
    returnPath: '/beeline/chat/room-1',
    startInstallation: async () => 'https://github.com/apps/beeline/installations/new',
    openAuthSession: async () => ({ type: 'dismiss' }),
    subscribeToUrls: () => ({ remove: () => undefined }),
    callbackGraceMs: 0,
  })).rejects.toMatchObject({ code: 'browser_canceled' });
  await loadLanding();
  expect(container.textContent).toBe('Returned to /beeline/chat/room-1');
  expect(mocks.operation).toHaveBeenCalledTimes(1);
});

it('GH-WEB-1: Back to Room leaves a failed refresh without displaying raw errors', async () => {
  mocks.operation.mockRejectedValueOnce(new Error('Repository refresh failed'));
  await loadLanding();
  expect(container.querySelector('h1')?.textContent).toBe('GitHub needs another try');
  expect(container.textContent).toContain('Continue connecting GitHub');
  expect(container.textContent).toContain('Return to your Room to refresh repositories and finish setup.');
  expect(container.textContent).not.toContain('Repository refresh failed');
  expect(container.querySelector('button')?.textContent).toBe('Back to Room');
  await act(async () => { container.querySelector('button')!.click(); });
  expect(mocks.operation).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe('/beeline/channels');
  expect(container.querySelector('button')).toBeNull();
});

it('hands the successful callback to the opener using Expo and returns to the saved Room', async () => {
  await persistGitHubInstallationReturnPath('/beeline/chat/room-1');
  const postMessage = vi.fn();
  Object.defineProperty(window, 'opener', { configurable: true, value: { postMessage, location: window.location } });
  window.localStorage.setItem('ExpoWebBrowserRedirectHandle', 'install-session');
  window.localStorage.setItem('ExpoWebBrowser_RedirectUrl_install-session', `${window.location.host}/beeline/github-installation`);
  await loadLanding();
  expect(postMessage).toHaveBeenCalledWith({
    url: `${window.location.origin}/beeline/github-installation?installed=1`, expoSender: 'install-session',
  }, `${window.location.origin}/beeline/github-installation?installed=1`);
  expect(window.location.pathname).toBe('/beeline/chat/room-1');
  expect(await githubInstallationReturnPath()).toBeNull();
  expect(await resumeInitialGitHubInstallation(async () => null)).toBe(false);
});

it('shows shared recovery for a GitHub failure and returns to the saved Room', async () => {
  await persistGitHubInstallationReturnPath('/beeline/chat/room-1');
  window.history.replaceState(null, '', '/beeline/github-installation?installed=0&error=github_connection_canceled');
  await loadLanding();
  expect(container.querySelector('h1')?.textContent).toBe('GitHub needs another try');
  expect(container.textContent).toContain('Continue connecting GitHub');
  expect(container.textContent).not.toContain('GitHub connection canceled');
  expect(container.querySelector('button')?.textContent).toBe('Back to Room');
  await act(async () => { container.querySelector('button')!.click(); });
  expect(window.location.pathname).toBe('/beeline/chat/room-1');
  expect(await githubInstallationReturnPath()).toBeNull();
  expect(await resumeInitialGitHubInstallation(async () => null)).toBe(false);
  expect(mocks.operation).not.toHaveBeenCalled();
});
