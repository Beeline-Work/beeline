import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retrieveTempText } from '@/sync/persistence';
import * as Clipboard from 'expo-clipboard';
import { HullDialog } from '@/components/buzz/HullDialog';
import { PageHeader } from '@/components/buzz/PageHeader';

type Notice = {
    title: string;
    message?: string;
    exitsScreen?: boolean;
};

export default function TextSelectionScreen() {
    const router = useRouter();
    const { textId } = useLocalSearchParams<{ textId: string }>();
    const insets = useSafeAreaInsets();
    const [fullText, setFullText] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [notice, setNotice] = React.useState<Notice | null>(null);

    const handleCopyAll = React.useCallback(async () => {
        if (!fullText) {
            setNotice({ title: "Error", message: "No text available to copy" });
            return;
        }

        try {
            await Clipboard.setStringAsync(fullText);
            setNotice({ title: "Text copied to clipboard" });
        } catch {
            setNotice({ title: "Error", message: "Failed to copy text to clipboard" });
        }
    }, [fullText]);

    React.useEffect(() => {
        if (!textId) {
            setNotice({
                title: "Error",
                message: "No text provided",
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
                title: "Error",
                message: "Text not found or expired",
                exitsScreen: true,
            });
        }
        setLoading(false);
    }, [textId]);

    const copyDisabled = loading || !fullText;

    const dismissNotice = () => {
        if (notice?.exitsScreen) {
            router.back();
            return;
        }
        setNotice(null);
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <PageHeader
                action={
                    <Pressable
                        accessibilityLabel={"Copy"}
                        accessibilityRole="button"
                        disabled={copyDisabled}
                        onPress={handleCopyAll}
                        style={({ pressed }) => [
                            styles.copyButton,
                            pressed && styles.copyButtonPressed,
                        ]}
                        testID="text-selection-copy"
                    >
                        <Text style={[styles.copyGlyph, copyDisabled && styles.copyGlyphDisabled]}>⧉</Text>
                    </Pressable>
                }
                backAccessibilityLabel={"Back"}
                onBack={() => router.back()}
                testID="text-selection-header"
                title={"Select Text"}
            />
            {loading ? (
                <Text style={styles.loadingText}>{"Loading..."}</Text>
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
                        accessibilityLabel={"Select Text"}
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
                actions={[{ label: "OK", onPress: dismissNotice }]}
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
        marginTop: theme.buzz.space.xxl,
        color: theme.buzz.textMuted,
        ...theme.buzz.type.body,
        textAlign: 'center',
    },
    textContainer: {
        flex: 1,
        paddingHorizontal: theme.buzz.space.md,
    },
    scrollContent: {
        flexGrow: 1,
        paddingTop: theme.buzz.space.md,
    },
    textContent: {
        minHeight: 200,
        paddingHorizontal: 0,
        paddingVertical: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
        color: theme.buzz.textPrimary,
        ...theme.buzz.type.machine,
        textAlignVertical: 'top',
    },
    copyButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    copyButtonPressed: {
        backgroundColor: theme.buzz.bgPressed,
    },
    copyGlyph: {
        color: theme.buzz.chrome,
        ...theme.buzz.type.meta,
        fontFamily: theme.buzz.monoSemibold,
    },
    copyGlyphDisabled: {
        color: theme.buzz.textMuted,
    },
}));
