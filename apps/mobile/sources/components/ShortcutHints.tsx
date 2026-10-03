import * as React from 'react';
import { Platform, StyleProp, Text, View, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import {
    formatShortcut,
    GLOBAL_SHORTCUTS,
    GlobalShortcutId,
    ShortcutModifier,
} from '@/keyboard/shortcuts';

interface ShortcutHintsContextValue {
    modifier: ShortcutModifier | null;
    visible: boolean;
    browserSafeShortcuts: boolean;
    sessionShortcutNumbers: Readonly<Record<string, number>>;
}

const EMPTY_SESSION_SHORTCUT_NUMBERS: Readonly<Record<string, number>> = {};

const ShortcutHintsContext = React.createContext<ShortcutHintsContextValue>({
    modifier: null,
    visible: false,
    browserSafeShortcuts: false,
    sessionShortcutNumbers: EMPTY_SESSION_SHORTCUT_NUMBERS,
});

const stylesheet = StyleSheet.create((theme) => ({
    overlay: {
        position: 'absolute',
        right: theme.buzz.space.lg,
        bottom: theme.buzz.space.lg,
        zIndex: 2000,
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: theme.buzz.space.sm,
        maxWidth: 520,
        padding: theme.buzz.space.sm,
        borderRadius: theme.buzz.radius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.buzz.borderStrong,
        backgroundColor: theme.buzz.bgRaised,
    },
    overlayItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.buzz.space.sm,
        paddingVertical: theme.buzz.space.xs,
        paddingHorizontal: theme.buzz.space.sm,
        borderRadius: theme.buzz.radius,
        backgroundColor: theme.colors.surfaceHigh,
    },
    overlayLabel: {
        ...theme.buzz.type.meta,
        fontFamily: theme.buzz.proseSemibold,
        color: theme.colors.text,
    },
    keycap: {
        minWidth: 30,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.buzz.space.sm,
        paddingVertical: theme.buzz.space.xs,
        borderRadius: theme.buzz.radius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    keycapText: {
        ...theme.buzz.type.machine,
        fontFamily: theme.buzz.monoSemibold,
        color: theme.colors.text,
    },
    badge: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.buzz.space.sm,
        paddingVertical: theme.buzz.space.xs,
        borderRadius: theme.buzz.radius,
        backgroundColor: theme.colors.surfaceHighest,
    },
    badgeText: {
        ...theme.buzz.type.machine,
        fontFamily: theme.buzz.monoSemibold,
        color: theme.colors.textSecondary,
    },
}));

const shortcutLabels: Record<GlobalShortcutId, () => string> = {
    commandPalette: () => t('settingsFeatures.commandPalette'),
    newSession: () => t('sidebar.newSession'),
    settings: () => t('settings.title'),
};

export function useShortcutHints() {
    return React.useContext(ShortcutHintsContext);
}

export function ShortcutHintsProvider({
    modifier,
    commandPaletteEnabled,
    recentSessionIds,
    browserSafeShortcuts,
    children,
}: {
    modifier: ShortcutModifier | null;
    commandPaletteEnabled: boolean;
    recentSessionIds: readonly string[];
    browserSafeShortcuts: boolean;
    children: React.ReactNode;
}) {
    const visible = Platform.OS === 'web' && modifier !== null;
    const sessionShortcutNumbers = React.useMemo(() => visible
        ? Object.fromEntries(recentSessionIds.map((sessionId, index) => [sessionId, index + 1]))
        : EMPTY_SESSION_SHORTCUT_NUMBERS,
    [recentSessionIds, visible]);
    const value = React.useMemo(() => ({
        modifier,
        visible,
        browserSafeShortcuts,
        sessionShortcutNumbers,
    }), [browserSafeShortcuts, modifier, visible, sessionShortcutNumbers]);

    return (
        <ShortcutHintsContext.Provider value={value}>
            {children}
            {visible && modifier && (
                <View pointerEvents="none" style={stylesheet.overlay} testID="shortcut-hints-overlay">
                    {GLOBAL_SHORTCUTS
                        .filter((shortcut) => shortcut.id !== 'commandPalette' || commandPaletteEnabled)
                        .map((shortcut) => (
                            <View key={shortcut.id} style={stylesheet.overlayItem}>
                                <View style={stylesheet.keycap}>
                                    <Text style={stylesheet.keycapText}>
                                        {formatShortcut(modifier, shortcut.keyLabel, browserSafeShortcuts)}
                                    </Text>
                                </View>
                                <Text style={stylesheet.overlayLabel}>{shortcutLabels[shortcut.id]()}</Text>
                            </View>
                        ))}
                </View>
            )}
        </ShortcutHintsContext.Provider>
    );
}

export function ShortcutHintBadge({
    shortcutKey,
    style,
}: {
    shortcutKey: string;
    style?: StyleProp<ViewStyle>;
}) {
    const { browserSafeShortcuts, modifier, visible } = useShortcutHints();
    if (!visible || !modifier) {
        return null;
    }

    return (
        <View pointerEvents="none" style={[stylesheet.badge, style]}>
            <Text style={stylesheet.badgeText}>
                {formatShortcut(modifier, shortcutKey, browserSafeShortcuts)}
            </Text>
        </View>
    );
}

export function SessionShortcutHintBadge({
    sessionId,
    style,
}: {
    sessionId: string;
    style?: StyleProp<ViewStyle>;
}) {
    const { sessionShortcutNumbers } = useShortcutHints();
    const shortcutNumber = sessionShortcutNumbers[sessionId];
    if (!shortcutNumber) {
        return null;
    }

    return <ShortcutHintBadge shortcutKey={String(shortcutNumber)} style={style} />;
}
