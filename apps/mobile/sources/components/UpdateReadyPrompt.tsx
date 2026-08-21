import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useUpdates } from '@/hooks/useUpdates';

/** A root-level affordance that remains visible over every interactive route. */
export const UpdateReadyPrompt = React.memo(function UpdateReadyPrompt() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { promptVisible, reloadApp, dismissPrompt } = useUpdates();

    if (!promptVisible) return null;

    return (
        <View
            pointerEvents="box-none"
            style={[styles.overlay, { top: insets.top + 12 }]}
            testID="ota-update-ready-prompt"
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Update ready — tap to restart"
                onPress={() => void reloadApp()}
                style={styles.prompt}
                testID="ota-update-restart"
            >
                <Ionicons name="download-outline" size={22} color={theme.colors.textLink} />
                <View style={styles.copy}>
                    <Text style={styles.title}>Update ready</Text>
                    <Text style={styles.subtitle}>Tap to restart</Text>
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss update prompt"
                    hitSlop={10}
                    onPress={(event) => {
                        event.stopPropagation();
                        dismissPrompt();
                    }}
                    style={styles.dismiss}
                    testID="ota-update-dismiss"
                >
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    overlay: {
        position: 'absolute',
        left: 12,
        right: 12,
        alignItems: 'center',
        zIndex: 2000,
        elevation: 20,
    },
    prompt: {
        width: '100%',
        maxWidth: 520,
        minHeight: 60,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.textLink,
        shadowColor: '#000',
        shadowOpacity: 0.22,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
    },
    copy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default(),
    },
    dismiss: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
