import React from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retrieveTempText } from '@/sync/persistence';
import { t } from '@/text';
import * as Clipboard from 'expo-clipboard';
import { HullActionSheet } from '@/components/buzz/HullActionSheet';

type Notice = {
    title: string;
    message?: string;
    exitsScreen?: boolean;
};

export default function TextSelectionScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const { textId } = useLocalSearchParams<{ textId: string }>();
    const insets = useSafeAreaInsets();
    const [fullText, setFullText] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [notice, setNotice] = React.useState<Notice | null>(null);

    const handleCopyAll = React.useCallback(async () => {
        if (!fullText) {
            setNotice({ title: t('common.error'), message: t('textSelection.noTextToCopy') });
            return;
        }

        try {
            await Clipboard.setStringAsync(fullText);
            setNotice({ title: t('textSelection.textCopied') });
        } catch {
            setNotice({ title: t('common.error'), message: t('textSelection.failedToCopy') });
        }
    }, [fullText]);

    React.useLayoutEffect(() => {
        const disabled = loading || !fullText;
        navigation.setOptions({
            headerRight: () => (
                <Pressable
                    accessibilityLabel={t('common.copy')}
                    accessibilityRole="button"
                    disabled={disabled}
                    onPress={handleCopyAll}
                    style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
                >
                    <Text style={[styles.copyGlyph, disabled && styles.copyGlyphDisabled]}>⧉</Text>
                </Pressable>
            ),
        });
    }, [navigation, handleCopyAll, loading, fullText]);

    React.useEffect(() => {
        if (!textId) {
            setNotice({
                title: t('common.error'),
                message: t('textSelection.noTextProvided'),
                exitsScreen: true,
            });
            setLoading(false);
            return;
        }

        const content = retrieveTempText(textId);
        if (content) {
            setFullText(content);
        } else {
            setNotice({
                title: t('common.error'),
                message: t('textSelection.textNotFound'),
                exitsScreen: true,
            });
        }
        setLoading(false);
    }, [textId]);

    const dismissNotice = () => {
        if (notice?.exitsScreen) {
            router.back();
            return;
        }
        setNotice(null);
    };

    return (
        <View style={styles.container}>
            {loading ? (
                <Text style={styles.loadingText}>{t('common.loading')}</Text>
            ) : (
                <ScrollView
                    style={styles.textContainer}
                    showsVerticalScrollIndicator
                    contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 16 }]}
                >
                    <TextInput
                        accessibilityLabel={t('textSelection.title')}
                        editable={false}
                        multiline
                        scrollEnabled={false}
                        selectTextOnFocus={false}
                        style={styles.textInput}
                        value={fullText}
                    />
                </ScrollView>
            )}

            {notice ? (
                <View style={styles.overlay} testID="text-selection-notice">
                    <View style={styles.scrim} />
                    <HullActionSheet style={[styles.sheet, { marginBottom: insets.bottom + 12 }]}>
                        <View style={styles.sheetCopy}>
                            <Text style={styles.sheetTitle}>{notice.title}</Text>
                            {notice.message ? <Text style={styles.sheetBody}>{notice.message}</Text> : null}
                        </View>
                        <Pressable
                            accessibilityRole="button"
                            onPress={dismissNotice}
                            style={({ pressed }) => [styles.noticeAction, pressed && styles.noticeActionPressed]}
                        >
                            <Text style={styles.noticeActionText}>{t('common.ok')}</Text>
                        </Pressable>
                    </HullActionSheet>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.buzz.bgTerminal,
    },
    loadingText: {
        marginTop: 50,
        color: theme.buzz.textMuted,
        fontFamily: theme.buzz.proseRegular,
        fontSize: 15,
        lineHeight: 21,
        textAlign: 'center',
    },
    textContainer: {
        flex: 1,
        paddingHorizontal: 18,
    },
    scrollContent: {
        flexGrow: 1,
        paddingTop: 18,
    },
    textInput: {
        minHeight: 200,
        paddingHorizontal: 0,
        paddingVertical: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
        color: theme.buzz.textPrimary,
        fontFamily: theme.buzz.monoRegular,
        fontSize: 14,
        lineHeight: 21,
        textAlignVertical: 'top',
    },
    copyButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 4,
    },
    copyButtonPressed: {
        backgroundColor: theme.buzz.bgPressed,
    },
    copyGlyph: {
        color: theme.buzz.chrome,
        fontFamily: theme.buzz.monoSemibold,
        fontSize: 20,
        lineHeight: 24,
    },
    copyGlyphDisabled: {
        color: theme.buzz.textMuted,
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
    noticeAction: {
        minHeight: 50,
        alignItems: 'center',
        justifyContent: 'center',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.buzz.border,
    },
    noticeActionPressed: {
        backgroundColor: theme.buzz.bgPressed,
    },
    noticeActionText: {
        color: theme.buzz.accent,
        fontFamily: theme.buzz.monoSemibold,
        fontSize: 12,
        letterSpacing: 0.7,
        textTransform: 'uppercase',
    },
}));
