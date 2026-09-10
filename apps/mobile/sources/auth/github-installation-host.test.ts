import React from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getInitialURL = vi.hoisted(() =>
  vi.fn(async () => 'beeline://beeline/github-installation?installed=1'),
);
const runGitHubInstallationSession = vi.hoisted(() => vi.fn(async () => null));
const resumeInitialGitHubInstallation = vi.hoisted(() => vi.fn(async () => false));
const openAuthSessionAsync = vi.hoisted(() => vi.fn(async () => ({ type: 'success' })));
const addUrlListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
const addAppStateListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));

vi.mock('react-native', () => ({
  AppState: { addEventListener: addAppStateListener },
  Linking: {
    addEventListener: addUrlListener,
    getInitialURL,
  },
  Platform: { OS: 'android' },
}));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync,
}));
vi.mock('@/auth/github-auth-session', () => ({
  githubInstallationRedirectUri: () => 'beeline://beeline/github-installation',
  githubRepositoryRefreshFeedback: (phase: string) => {
    if (phase === 'awaiting_return') {
      return {
        notice: 'Choose the repositories Beeline may access, then return.',
        error: null,
      };
    }
    if (phase === 'refreshing') return { notice: 'Refreshing repositories…', error: null };
    if (phase === 'refreshed') return { notice: 'Repositories refreshed.', error: null };
    return {
      notice: null,
      error: 'Could not refresh repositories. Return to Beeline and try again.',
    };
  },
  resumeInitialGitHubInstallation,
  runGitHubInstallationSession,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useGitHubInstallationSession } = await import('./github-installation-host');

function mount(overrides: Partial<Parameters<typeof useGitHubInstallationSession>[0]> = {}) {
  const startInstallation = vi.fn(async (installationId?: number) =>
    installationId
      ? `https://github.test/install/${installationId}`
      : 'https://github.test/install/new',
  );
  const refreshRepositories = vi.fn(async () => undefined);
  const onError = vi.fn();
  const onNotice = vi.fn();
  const onColdResume = vi.fn(async () => undefined);
  const props = {
    ready: true,
    returnPath: '/beeline/channels',
    startInstallation,
    refreshRepositories,
    onError,
    onNotice,
    onColdResume,
    ...overrides,
  };
  let latest: ReturnType<typeof useGitHubInstallationSession> | undefined;
  function Harness() {
    latest = useGitHubInstallationSession(props);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(Harness));
  });
  return {
    renderer,
    get: () => latest!,
    startInstallation,
    refreshRepositories,
    onError,
    onNotice,
    onColdResume,
  };
}

describe('GitHub installation host session', () => {
  beforeEach(() => {
    runGitHubInstallationSession.mockReset();
    runGitHubInstallationSession.mockImplementation(
      async (input: {
        returnPath: string;
        startInstallation: () => Promise<string>;
        onRefreshPhase?: (phase: string) => void;
      }) => {
        input.onRefreshPhase?.('awaiting_return');
        await input.startInstallation();
        input.onRefreshPhase?.('refreshed');
        return 'beeline://beeline/github-installation?installed=1';
      },
    );
    resumeInitialGitHubInstallation.mockReset();
    resumeInitialGitHubInstallation.mockResolvedValue(false);
    getInitialURL.mockClear();
  });

  it('runs the state-bound install session from the deck return path', async () => {
    const session = mount();
    await act(async () => {
      await session.get().handleAddGitHubAccount();
    });
    expect(runGitHubInstallationSession).toHaveBeenCalledWith(
      expect.objectContaining({ returnPath: '/beeline/channels' }),
    );
    expect(session.startInstallation).toHaveBeenCalledWith(undefined);
    expect(session.onNotice).toHaveBeenCalledWith(
      'Choose the repositories Beeline may access, then return.',
    );
  });

  it('manages an existing installation through the same session', async () => {
    const session = mount({ returnPath: '/beeline/chat/room-1' });
    await act(async () => {
      await session.get().handleManageGitHubInstallation({ installationId: 78 });
    });
    expect(runGitHubInstallationSession).toHaveBeenCalledWith(
      expect.objectContaining({ returnPath: '/beeline/chat/room-1' }),
    );
    expect(session.startInstallation).toHaveBeenCalledWith(78);
  });

  it('opens the picker and refreshes after a cold-start install return', async () => {
    resumeInitialGitHubInstallation.mockImplementation(async (getInitialUrl) => {
      expect(await getInitialUrl()).toBe('beeline://beeline/github-installation?installed=1');
      return true;
    });
    const session = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(resumeInitialGitHubInstallation).toHaveBeenCalledTimes(1);
    expect(session.onColdResume).toHaveBeenCalledTimes(1);
    expect(session.refreshRepositories).toHaveBeenCalledTimes(1);
  });

  it('does not resume when no pending cold installation exists', async () => {
    const session = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(session.onColdResume).not.toHaveBeenCalled();
    expect(session.refreshRepositories).not.toHaveBeenCalled();
  });

  it('surfaces a session failure on the picker error line', async () => {
    runGitHubInstallationSession.mockRejectedValue(new Error('installation exploded'));
    const session = mount();
    await act(async () => {
      await session.get().handleAddGitHubAccount();
    });
    expect(session.onError).toHaveBeenCalledWith(
      'Could not connect GitHub: Error: installation exploded',
    );
  });
});
