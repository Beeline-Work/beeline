import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { StyleSheet, useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Pressable, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { editorialTheme, ledgerTheme, obsidianTheme } from '@/theme';
import { beelineThemes } from '@/buzz/groknight';
import { THEME_PREFERENCES, type ThemePreference } from '@/sync/localSettings';
import { SESSION_STATUS_BAR_DISPLAY_MODES, type SessionStatusBarDisplay } from '@/sync/settings';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';
import {
    normalizeUserMessageBubbleColor,
    resolveUserMessageBubbleColor,
    USER_MESSAGE_BUBBLE_COLORS,
    type UserMessageBubbleColor,
} from '@/utils/userMessageBubbleColor';
import * as React from 'react';
import { AnimatedCollapsible } from '@/components/AnimatedOverlay';
import { SettingsNavigationRow } from '@/components/buzz/SettingsNavigationRow';

const appThemes = {
    obsidian: obsidianTheme,
    editorial: editorialTheme,
    ledger: ledgerTheme,
} as const;

function applyAppTheme(nextTheme: ThemePreference) {
    UnistylesRuntime.setTheme(nextTheme);
    const color = appThemes[nextTheme].colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    void SystemUI.setBackgroundColorAsync(color);
}

const getUserMessageBubbleColorLabel = (color: UserMessageBubbleColor): string => {
    switch (color) {
        case 'blue':
            return t('settingsAppearance.userMessageBubbleColorOptions.blue');
        case 'green':
            return t('settingsAppearance.userMessageBubbleColorOptions.green');
        case 'purple':
            return t('settingsAppearance.userMessageBubbleColorOptions.purple');
        case 'rose':
            return t('settingsAppearance.userMessageBubbleColorOptions.rose');
        case 'sand':
            return t('settingsAppearance.userMessageBubbleColorOptions.sand');
        case 'gray':
            return t('settingsAppearance.userMessageBubbleColorOptions.gray');
    }
};

const getSessionStatusDisplayLabel = (mode: SessionStatusBarDisplay): string => {
    switch (mode) {
        case 'hidden':
            return t('settingsAppearance.sessionStatusDisplayOptions.hidden');
        case 'above':
            return t('settingsAppearance.sessionStatusDisplayOptions.above');
        case 'below':
            return t('settingsAppearance.sessionStatusDisplayOptions.below');
    }
};

const getSessionStatusDisplayGlyph = (mode: SessionStatusBarDisplay): string => {
    switch (mode) {
        case 'hidden':
            return '—';
        case 'above':
            return '↑';
        case 'below':
            return '↓';
    }
};

function BubbleColorPreview({ color }: { color: UserMessageBubbleColor }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const palette = resolveUserMessageBubbleColor(color, theme.dark);

    return (
        <View
            style={[
                styles.bubblePreview,
                {
                    backgroundColor: palette.background,
                    borderColor: palette.border,
                },
            ]}
        >
            <View style={[styles.bubblePreviewLine, { backgroundColor: palette.indicator, width: 18 }]} />
            <View style={[styles.bubblePreviewLine, { backgroundColor: palette.indicator, width: 26 }]} />
        </View>
    );
}

function BubbleColorDropdownValue(props: {
    color: UserMessageBubbleColor;
    label: string;
    expanded: boolean;
}) {
    const styles = stylesheet;

    return (
        <View style={styles.dropdownValue}>
            <BubbleColorPreview color={props.color} />
            <Text style={styles.dropdownValueText} numberOfLines={1}>
                {props.label}
            </Text>
            <Text style={styles.dropdownGlyph}>{props.expanded ? '⌃' : '⌄'}</Text>
        </View>
    );
}

function StatusDisplayDropdownValue(props: {
    mode: SessionStatusBarDisplay;
    expanded: boolean;
}) {
    const styles = stylesheet;

    return (
        <View style={styles.dropdownValue}>
            <Text style={styles.dropdownValueText} numberOfLines={1}>
                {getSessionStatusDisplayLabel(props.mode)}
            </Text>
            <Text style={styles.dropdownGlyph}>{props.expanded ? '⌃' : '⌄'}</Text>
        </View>
    );
}

function StatusDisplayOption(props: {
    mode: SessionStatusBarDisplay;
    selected: boolean;
    onPress: () => void;
}) {
    const styles = stylesheet;

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.statusPlacementOption,
                props.selected && styles.statusPlacementOptionSelected,
                pressed && styles.statusPlacementOptionPressed,
            ]}
        >
            <Text style={[styles.optionGlyph, props.selected && styles.optionGlyphSelected]}>
                {getSessionStatusDisplayGlyph(props.mode)}
            </Text>
            <Text style={styles.statusPlacementOptionText} numberOfLines={1}>
                {getSessionStatusDisplayLabel(props.mode)}
            </Text>
            {props.selected ? (
                <Text style={styles.optionCheck}>✓</Text>
            ) : (
                <View style={styles.bubbleColorOptionCheckPlaceholder} />
            )}
        </Pressable>
    );
}

function BubbleColorOption(props: {
    color: UserMessageBubbleColor;
    selected: boolean;
    onPress: () => void;
}) {
    const styles = stylesheet;

    return (
        <Pressable
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.bubbleColorOption,
                props.selected && styles.bubbleColorOptionSelected,
                pressed && styles.bubbleColorOptionPressed,
            ]}
        >
            <BubbleColorPreview color={props.color} />
            <Text style={styles.bubbleColorOptionText} numberOfLines={1}>
                {getUserMessageBubbleColorLabel(props.color)}
            </Text>
            {props.selected ? (
                <Text style={styles.optionCheck}>✓</Text>
            ) : (
                <View style={styles.bubbleColorOptionCheckPlaceholder} />
            )}
        </Pressable>
    );
}

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [viewInline, setViewInline] = useSettingMutable('viewInline');
    const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
    const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [compactToolCalls, setCompactToolCalls] = useSettingMutable('compactToolCalls');
    const [userMessageBubbleColor, setUserMessageBubbleColor] = useSettingMutable('userMessageBubbleColor');
    const [sessionStatusBarDisplay, setSessionStatusBarDisplay] = useSettingMutable('sessionStatusBarDisplay');
    const [usageLimitShowRemaining, setUsageLimitShowRemaining] = useSettingMutable('usageLimitShowRemaining');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');
    const [statusPlacementDropdownOpen, setStatusPlacementDropdownOpen] = React.useState(false);
    const [bubbleColorDropdownOpen, setBubbleColorDropdownOpen] = React.useState(false);
    
    const displayBubbleColor = normalizeUserMessageBubbleColor(userMessageBubbleColor);
    const displayBubbleColorLabel = getUserMessageBubbleColorLabel(displayBubbleColor);
    const applySessionStatusDisplay = React.useCallback((mode: SessionStatusBarDisplay) => {
        setSessionStatusBarDisplay(mode);
        setStatusPlacementDropdownOpen(false);
    }, [setSessionStatusBarDisplay]);
    
    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ? 
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) : 
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer="Stored on this device and applied throughout Beeline.">
                {THEME_PREFERENCES.map((name, index) => {
                    const option = beelineThemes[name];
                    const selected = themePreference === name;
                    return (
                        <Item
                            key={name}
                            title={option.label}
                            subtitle={option.description}
                            detail={selected ? 'Selected' : undefined}
                            showDivider={index < THEME_PREFERENCES.length - 1}
                            onPress={() => {
                                setThemePreference(name);
                                applyAppTheme(name);
                            }}
                        />
                    );
                })}
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsLanguage.title')}
                footer={t('settingsLanguage.description')}
                containerStyle={stylesheet.navigationGroup}
            >
                <SettingsNavigationRow
                    glyph="Aa"
                    label={t('settingsLanguage.currentLanguage')}
                    supportingCopy={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                    testID="language-settings-link"
                />
            </ItemGroup>

            <ItemGroup title={t('settingsAppearance.chat')} footer={t('settingsAppearance.chatDescription')}>
                <Item
                    title={t('settingsAppearance.sessionStatusBar')}
                    subtitle={t('settingsAppearance.sessionStatusBarDescription')}
                    rightElement={
                        <StatusDisplayDropdownValue
                            mode={sessionStatusBarDisplay}
                            expanded={statusPlacementDropdownOpen}
                        />
                    }
                    onPress={() => {
                        setBubbleColorDropdownOpen(false);
                        setStatusPlacementDropdownOpen((open) => !open);
                    }}
                    showDivider={statusPlacementDropdownOpen}
                />
                {statusPlacementDropdownOpen && (
                    <AnimatedCollapsible style={stylesheet.statusPlacementDropdown}>
                        {SESSION_STATUS_BAR_DISPLAY_MODES.map((mode) => (
                            <StatusDisplayOption
                                key={mode}
                                mode={mode}
                                selected={mode === sessionStatusBarDisplay}
                                onPress={() => applySessionStatusDisplay(mode)}
                            />
                        ))}
                    </AnimatedCollapsible>
                )}
                <Item
                    title={t('settingsAppearance.usageLimitShowRemaining')}
                    subtitle={t('settingsAppearance.usageLimitShowRemainingDescription')}
                    rightElement={
                        <Switch
                            value={usageLimitShowRemaining}
                            onValueChange={setUsageLimitShowRemaining}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.userMessageBubbleColor')}
                    subtitle={t('settingsAppearance.userMessageBubbleColorDescription')}
                    rightElement={
                        <BubbleColorDropdownValue
                            color={displayBubbleColor}
                            label={displayBubbleColorLabel}
                            expanded={bubbleColorDropdownOpen}
                        />
                    }
                    onPress={() => {
                        setStatusPlacementDropdownOpen(false);
                        setBubbleColorDropdownOpen((open) => !open);
                    }}
                    showDivider={bubbleColorDropdownOpen}
                />
                {bubbleColorDropdownOpen && (
                    <AnimatedCollapsible style={stylesheet.bubbleColorDropdown}>
                        {USER_MESSAGE_BUBBLE_COLORS.map((color) => (
                            <BubbleColorOption
                                key={color}
                                color={color}
                                selected={color === displayBubbleColor}
                                onPress={() => {
                                    setUserMessageBubbleColor(color);
                                    setBubbleColorDropdownOpen(false);
                                }}
                            />
                        ))}
                    </AnimatedCollapsible>
                )}
            </ItemGroup>

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.compactToolCalls')}
                    subtitle={t('settingsAppearance.compactToolCallsDescription')}
                    rightElement={
                        <Switch
                            value={compactToolCalls}
                            onValueChange={setCompactToolCalls}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.inlineToolCalls')}
                    subtitle={t('settingsAppearance.inlineToolCallsDescription')}
                    rightElement={
                        <Switch
                            value={viewInline}
                            onValueChange={setViewInline}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.expandTodoLists')}
                    subtitle={t('settingsAppearance.expandTodoListsDescription')}
                    rightElement={
                        <Switch
                            value={expandTodos}
                            onValueChange={setExpandTodos}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInDiffs')}
                    subtitle={t('settingsAppearance.showLineNumbersInDiffsDescription')}
                    rightElement={
                        <Switch
                            value={showLineNumbers}
                            onValueChange={setShowLineNumbers}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInToolViews')}
                    subtitle={t('settingsAppearance.showLineNumbersInToolViewsDescription')}
                    rightElement={
                        <Switch
                            value={showLineNumbersInToolViews}
                            onValueChange={setShowLineNumbersInToolViews}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.wrapLinesInDiffs')}
                    subtitle={t('settingsAppearance.wrapLinesInDiffsDescription')}
                    rightElement={
                        <Switch
                            value={wrapLinesInDiffs}
                            onValueChange={setWrapLinesInDiffs}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.diffStyle')}
                    subtitle={t('settingsAppearance.diffStyleDescription')}
                    detail={diffStyle === 'split' ? t('settingsAppearance.diffStyleOptions.split') : t('settingsAppearance.diffStyleOptions.unified')}
                    onPress={() => setDiffStyle(diffStyle === 'unified' ? 'split' : 'unified')}
                />
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    rightElement={
                        <Switch
                            value={alwaysShowContextSize}
                            onValueChange={setAlwaysShowContextSize}
                        />
                    }
                />
            </ItemGroup>
        </ItemList>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    navigationGroup: {
        borderTopWidth: 0,
    },
    dropdownValue: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: 184,
    },
    dropdownValueText: {
        color: theme.buzz.textMuted,
        fontFamily: theme.buzz.monoRegular,
        fontSize: 12,
        flexShrink: 1,
    },
    dropdownGlyph: {
        color: theme.buzz.chrome,
        fontFamily: theme.buzz.monoRegular,
        fontSize: 16,
    },
    bubbleColorDropdown: {
        paddingVertical: 6,
    },
    statusPlacementDropdown: {
        paddingVertical: 6,
    },
    statusPlacementOption: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    statusPlacementOptionSelected: {
        backgroundColor: theme.buzz.bgHighlight,
    },
    statusPlacementOptionPressed: {
        backgroundColor: theme.buzz.bgPressed,
    },
    statusPlacementOptionText: {
        color: theme.buzz.textPrimary,
        fontFamily: theme.buzz.proseRegular,
        fontSize: 16,
        flex: 1,
    },
    optionGlyph: {
        width: 20,
        color: theme.buzz.chrome,
        fontFamily: theme.buzz.monoRegular,
        fontSize: 16,
        textAlign: 'center',
    },
    optionGlyphSelected: {
        color: theme.buzz.accent,
    },
    optionCheck: {
        color: theme.buzz.accent,
        fontFamily: theme.buzz.monoSemibold,
        fontSize: 17,
    },
    bubbleColorOption: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    bubbleColorOptionSelected: {
        backgroundColor: theme.buzz.bgHighlight,
    },
    bubbleColorOptionPressed: {
        backgroundColor: theme.buzz.bgPressed,
    },
    bubbleColorOptionText: {
        color: theme.buzz.textPrimary,
        fontFamily: theme.buzz.proseRegular,
        fontSize: 16,
        flex: 1,
    },
    bubbleColorOptionCheckPlaceholder: {
        width: 20,
        height: 20,
    },
    bubblePreview: {
        width: 46,
        height: 28,
        borderRadius: theme.buzz.radius,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 9,
        overflow: 'hidden',
    },
    bubblePreviewLine: {
        height: 3,
        borderRadius: theme.buzz.radius,
    },
}));
