import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/buzz/onboarding' }));
const appState = vi.hoisted(() => ({
    listeners: new Set<(state: string) => void>(),
}));
const updates = vi.hoisted(() => ({
    checkForUpdateAsync: vi.fn(),
    fetchUpdateAsync: vi.fn(),
    reloadAsync: vi.fn(),
}));
const tracking = vi.hoisted(() => ({
    available: vi.fn(),
    applied: vi.fn(),
}));

vi.mock('expo-router', () => ({ usePathname: () => route.pathname }));
vi.mock('expo-updates', () => ({
    checkForUpdateAsync: updates.checkForUpdateAsync,
    fetchUpdateAsync: updates.fetchUpdateAsync,
    reloadAsync: updates.reloadAsync,
}));
vi.mock('@/track', () => ({
    trackOtaUpdateAvailable: tracking.available,
    trackOtaUpdateApplied: tracking.applied,
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('@/components/StyledText', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (factory: any) => factory({
            colors: {
                surface: '#111',
                text: '#fff',
                textLink: '#fc0',
                textSecondary: '#aaa',
            },
        }),
    },
    useUnistyles: () => ({
        theme: { colors: { textLink: '#fc0', textSecondary: '#aaa' } },
    }),
}));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        AppState: {
            addEventListener: (_event: string, listener: (state: string) => void) => {
                appState.listeners.add(listener);
                return { remove: () => appState.listeners.delete(listener) };
            },
        },
        Platform: { OS: 'ios' },
        Pressable: host('Pressable'),
        View: host('View'),
    };
});

import { UpdateProvider } from './useUpdates';
import { UpdateReadyPrompt } from '@/components/UpdateReadyPrompt';

const originalConsoleError = console.error;

beforeAll(() => {
    vi.stubGlobal('__DEV__', false);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

beforeEach(() => {
    vi.clearAllMocks();
    appState.listeners.clear();
    route.pathname = '/buzz/onboarding';
    updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: false, reason: 'noUpdateAvailableOnServer' });
    updates.fetchUpdateAsync.mockResolvedValue({ isNew: false });
    updates.reloadAsync.mockResolvedValue(undefined);
});

async function renderUpdateRoot(child?: React.ReactNode): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
        renderer = create(React.createElement(
            UpdateProvider,
            null,
            child ?? React.createElement('UnauthenticatedOnboarding'),
        ));
    });
    return renderer;
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => renderer.unmount());
}

function availableUpdate() {
    updates.checkForUpdateAsync.mockResolvedValue({
        isAvailable: true,
        manifest: { id: 'ota-next', runtimeVersion: '55' },
    });
    updates.fetchUpdateAsync.mockResolvedValue({
        isNew: true,
        manifest: { id: 'ota-next', runtimeVersion: '55' },
    });
}

describe('root OTA update coordinator', () => {
    it('checks for updates while the unauthenticated onboarding tree is mounted', async () => {
        const renderer = await renderUpdateRoot();

        expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAllByType('UnauthenticatedOnboarding' as any)).toHaveLength(1);
        await unmount(renderer);
    });

    it('reloads a fetched update immediately on a cold onboarding surface', async () => {
        availableUpdate();

        const renderer = await renderUpdateRoot();

        expect(updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
        expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
        await unmount(renderer);
    });

    it('surfaces a restart prompt instead of reloading during an active session', async () => {
        route.pathname = '/session/session-1';
        availableUpdate();

        const renderer = await renderUpdateRoot(React.createElement(UpdateReadyPrompt));

        expect(updates.reloadAsync).not.toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).not.toHaveLength(0);

        const restart = renderer.root.find(
            (node: any) => node.type === 'Pressable' && node.props.testID === 'ota-update-restart',
        );
        await act(async () => restart.props.onPress());
        expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
        await unmount(renderer);
    });

    it('lets the user dismiss the active-session restart prompt', async () => {
        route.pathname = '/buzz/chat/room-1';
        availableUpdate();
        const renderer = await renderUpdateRoot(React.createElement(UpdateReadyPrompt));
        const dismiss = renderer.root.find(
            (node: any) => node.type === 'Pressable' && node.props.testID === 'ota-update-dismiss',
        );

        await act(async () => dismiss.props.onPress({ stopPropagation: vi.fn() }));

        expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).toHaveLength(0);
        expect(updates.reloadAsync).not.toHaveBeenCalled();
        await unmount(renderer);
    });

    it('does not reload when the update download did not complete', async () => {
        route.pathname = '/buzz/onboarding';
        updates.checkForUpdateAsync.mockResolvedValue({
            isAvailable: true,
            manifest: { id: 'ota-next', runtimeVersion: '55' },
        });
        updates.fetchUpdateAsync.mockResolvedValue({
            isNew: false,
            manifest: undefined,
            isRollBackToEmbedded: false,
        });

        const renderer = await renderUpdateRoot(React.createElement(UpdateReadyPrompt));

        expect(updates.reloadAsync).not.toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ testID: 'ota-update-ready-prompt' })).toHaveLength(0);
        await unmount(renderer);
    });

    it('checks again whenever the app becomes active', async () => {
        const renderer = await renderUpdateRoot();
        expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);

        await act(async () => {
            for (const listener of appState.listeners) listener('active');
        });

        expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
        await unmount(renderer);
    });
});
