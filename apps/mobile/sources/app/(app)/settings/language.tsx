import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from '@/text';
import { useUpdates } from '@/hooks/useUpdates';
import * as Localization from 'expo-localization';
import { HullActionSheet } from '@/components/buzz/HullActionSheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type LanguageOption = 'auto' | SupportedLanguage;

interface LanguageItem {
    key: LanguageOption;
    title: string;
    subtitle?: string;
}

export default function LanguageSettingsScreen() {
    const { theme } = useUnistyles();
    const [preferredLanguage, setPreferredLanguage] = useSettingMutable('preferredLanguage');
    const { reloadApp } = useUpdates();
    const insets = useSafeAreaInsets();
    const [pendingLanguage, setPendingLanguage] = React.useState<LanguageOption | null>(null);

    // Get device locale for automatic detection
    const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
    const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
    const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ? 
                                 getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) : 
                                 getLanguageNativeName('en');

    // Current selection
    const currentSelection: LanguageOption = preferredLanguage === null ? 'auto' : 
                                           SUPPORTED_LANGUAGE_CODES.includes(preferredLanguage as SupportedLanguage) ? 
                                           preferredLanguage as SupportedLanguage : 'auto';

    // Language options - dynamically generated from supported languages
    const languageOptions: LanguageItem[] = [
        {
            key: 'auto',
            title: t('settingsLanguage.automatic'),
            subtitle: `${t('settingsLanguage.automaticSubtitle')} (${detectedLanguageName})`
        },
        ...SUPPORTED_LANGUAGE_CODES.map(code => ({
            key: code,
            title: getLanguageNativeName(code)
        }))
    ];

    const handleLanguageChange = (newLanguage: LanguageOption) => {
        if (newLanguage === currentSelection) {
            return; // No change
        }
        setPendingLanguage(newLanguage);
    };

    const confirmLanguageChange = () => {
        if (pendingLanguage === null) {
            return;
        }

        const newPreference = pendingLanguage === 'auto' ? null : pendingLanguage;
        setPendingLanguage(null);
        setPreferredLanguage(newPreference);

        // Small delay to ensure setting is saved before the restart.
        setTimeout(() => {
            reloadApp();
        }, 100);
    };

    return (
        <View style={styles.screen}>
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup
                    title={t('settingsLanguage.currentLanguage')}
                    footer={t('settingsLanguage.description')}
                >
                    {languageOptions.map((option) => (
                        <Item
                            key={option.key}
                            title={option.title}
                            subtitle={option.subtitle}
                            rightElement={
                                currentSelection === option.key ? (
                                    <Text style={{ color: theme.buzz.accent, fontFamily: theme.buzz.monoSemibold, fontSize: 17 }}>✓</Text>
                                ) : null
                            }
                            onPress={() => handleLanguageChange(option.key)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            </ItemList>

            {pendingLanguage !== null ? (
                <View style={styles.overlay} testID="language-restart-confirmation">
                    <Pressable
                        accessibilityLabel={t('common.cancel')}
                        accessibilityRole="button"
                        onPress={() => setPendingLanguage(null)}
                        style={styles.scrim}
                    />
                    <HullActionSheet style={[styles.sheet, { marginBottom: insets.bottom + 12 }]}>
                        <View style={styles.sheetCopy}>
                            <Text style={styles.sheetTitle}>{t('settingsLanguage.needsRestart')}</Text>
                            <Text style={styles.sheetBody}>{t('settingsLanguage.needsRestartMessage')}</Text>
                        </View>
                        <View style={styles.actions}>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => setPendingLanguage(null)}
                                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                            >
                                <Text style={styles.secondaryActionText}>{t('common.cancel')}</Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                onPress={confirmLanguageChange}
                                style={({ pressed }) => [styles.action, styles.primaryAction, pressed && styles.actionPressed]}
                            >
                                <Text style={styles.primaryActionText}>{t('common.ok')}</Text>
                            </Pressable>
                        </View>
                    </HullActionSheet>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.buzz.bgTerminal,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        paddingHorizontal: 12,
    },
    scrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.buzz.bgTerminal,
        opacity: 0.82,
    },
    sheet: {
        width: '100%',
    },
    sheetCopy: {
        paddingHorizontal: 18,
        paddingTop: 18,
        paddingBottom: 16,
    },
    sheetTitle: {
        color: theme.buzz.textPrimary,
        fontFamily: theme.buzz.proseSemibold,
        fontSize: 18,
        lineHeight: 24,
    },
    sheetBody: {
        marginTop: 7,
        color: theme.buzz.textMuted,
        fontFamily: theme.buzz.proseRegular,
        fontSize: 14,
        lineHeight: 20,
    },
    actions: {
        flexDirection: 'row',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.buzz.border,
    },
    action: {
        flex: 1,
        minHeight: 50,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primaryAction: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.buzz.border,
    },
    actionPressed: {
        backgroundColor: theme.buzz.bgPressed,
    },
    secondaryActionText: {
        color: theme.buzz.chrome,
        fontFamily: theme.buzz.monoSemibold,
        fontSize: 12,
        letterSpacing: 0.7,
        textTransform: 'uppercase',
    },
    primaryActionText: {
        color: theme.buzz.accent,
        fontFamily: theme.buzz.monoSemibold,
        fontSize: 12,
        letterSpacing: 0.7,
        textTransform: 'uppercase',
    },
}));
