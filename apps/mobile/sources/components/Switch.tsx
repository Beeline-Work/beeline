import * as React from 'react';
import { Pressable, View, type SwitchProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * Beeline setting toggle. The rectangular rail keeps switches in the same
 * three-pixel control family as the rest of the hull instead of borrowing the
 * platform pill silhouette.
 */
export const Switch = React.memo((props: SwitchProps) => {
    const styles = stylesheet;
    const {
        value = false,
        disabled = false,
        onValueChange,
        accessibilityLabel,
        accessibilityHint,
        testID,
        style,
    } = props;

    return (
        <Pressable
            accessibilityRole="switch"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ checked: value, disabled }}
            disabled={disabled}
            onPress={() => onValueChange?.(!value)}
            hitSlop={8}
            testID={testID}
            style={({ pressed }) => [
                styles.hitTarget,
                style,
                disabled && styles.disabled,
                pressed && styles.pressed,
            ]}
        >
            <View style={[styles.track, value ? styles.trackActive : styles.trackInactive]}>
                <View style={[styles.thumb, value ? styles.thumbActive : styles.thumbInactive]} />
            </View>
        </Pressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    hitTarget: {
        width: 48,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    track: {
        width: 42,
        height: 24,
        borderRadius: theme.buzz.radius,
        borderWidth: StyleSheet.hairlineWidth,
        padding: 3,
        justifyContent: 'center',
    },
    trackActive: {
        alignItems: 'flex-end',
        backgroundColor: theme.buzz.accent,
        borderColor: theme.buzz.accent,
    },
    trackInactive: {
        alignItems: 'flex-start',
        backgroundColor: theme.buzz.bgRaised,
        borderColor: theme.buzz.borderStrong,
    },
    thumb: {
        width: 16,
        height: 16,
        borderRadius: theme.buzz.radius,
    },
    thumbActive: {
        backgroundColor: theme.buzz.bgTerminal,
    },
    thumbInactive: {
        backgroundColor: theme.buzz.textMuted,
    },
    disabled: {
        opacity: 0.45,
    },
    pressed: {
        opacity: 0.72,
    },
}));
