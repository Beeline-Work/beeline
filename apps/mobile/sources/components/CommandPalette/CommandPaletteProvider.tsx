import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { CommandPalette } from './CommandPalette';
import { Command } from './types';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { storage } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { ShortcutHintsProvider } from '@/components/ShortcutHints';
import {
    formatShortcut,
    getPreferredShortcutModifier,
} from '@/keyboard/shortcuts';
import { isTauri } from '@/utils/isTauri';

const EMPTY_SESSION_IDS: readonly string[] = [];

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const commandPaletteEnabled = storage(useShallow((state) => state.localSettings.commandPaletteEnabled));
    const preferredModifier = useMemo(() => getPreferredShortcutModifier(
        typeof navigator === 'undefined' ? undefined : navigator
    ), []);
    const browserSafeShortcuts = useMemo(() => Platform.OS === 'web' && !isTauri(), []);

    // Define available commands
    const commands = useMemo((): Command[] => {
        const cmds: Command[] = [
            // Navigation commands
            {
                id: 'rooms',
                title: 'Rooms',
                subtitle: 'Open the Beeline Room list',
                icon: 'grid-outline',
                category: 'Navigation',
                shortcut: formatShortcut(preferredModifier, 'N', browserSafeShortcuts),
                action: () => {
                    router.navigate('/buzz/channels');
                }
            },
            {
                id: 'settings',
                title: 'Settings',
                subtitle: 'Configure your preferences',
                icon: 'settings-outline',
                category: 'Navigation',
                shortcut: formatShortcut(preferredModifier, ',', browserSafeShortcuts),
                action: () => {
                    router.push('/buzz/settings');
                }
            },
        ];

        return cmds;
    }, [browserSafeShortcuts, router, preferredModifier]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || !commandPaletteEnabled) return;
        
        Modal.show({
            component: CommandPalette,
            props: {
                commands,
            }
        } as any);
    }, [commands, commandPaletteEnabled]);

    const openRooms = useCallback(() => {
        router.navigate('/buzz/channels');
    }, [router]);

    const openSettings = useCallback(() => {
        router.push('/buzz/settings');
    }, [router]);

    const visibleModifier = useGlobalKeyboard(
        {
            commandPalette: commandPaletteEnabled ? showCommandPalette : undefined,
            newSession: openRooms,
            settings: openSettings,
        },
        browserSafeShortcuts,
    );

    return (
        <ShortcutHintsProvider
            modifier={visibleModifier}
            commandPaletteEnabled={commandPaletteEnabled}
            recentSessionIds={EMPTY_SESSION_IDS}
            browserSafeShortcuts={browserSafeShortcuts}
        >
            {children}
        </ShortcutHintsProvider>
    );
}
