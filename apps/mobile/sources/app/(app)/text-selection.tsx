import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retrieveTempText } from '@/sync/persistence';
import { t } from '@/text';
import * as Clipboard from 'expo-clipboard';
import { HullDialog } from '@/components/buzz/HullDialog';

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
                    style={({ pressed }) => [
                        styles.copyButton,
                        pressed && styles.copyButtonPressed,
                    ]}
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
                    contentContainerStyle={[
                        styles.scrollContent,
                        { paddingBottom: insets.bottom + 16 },
                    ]}
                >
                    <Text
                        accessibilityLabel={t('textSelection.title')}
                        selectable
                        style={styles.textContent}
                    >
                        {fullText}
                    </Text>
                </ScrollView>
            )}

            <HullDialog
                visible={notice !== null}
                onRequestClose={dismissNotice}
                dismissOnBackdrop={false}
                title={notice?.title ?? ''}
                body={notice?.message}
                testID="text-selection-notice"
                actions={[{ label: t('common.ok'), onPress: dismissNotice }]}
            />
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
    textContent: {
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
}));
