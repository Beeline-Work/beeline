import * as React from 'react';
import { Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
    Easing,
    FadeIn,
    FadeOut,
    ReduceMotion,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

const enterEasing = Easing.out(Easing.cubic);
const exitEasing = Easing.in(Easing.cubic);

const backdropEntering = FadeIn
    .duration(180)
    .easing(enterEasing)
    .reduceMotion(ReduceMotion.System);

const backdropExiting = FadeOut
    .duration(140)
    .easing(exitEasing)
    .reduceMotion(ReduceMotion.System);


export function AnimatedBlurBackdrop({
    blurIntensity = 42,
    dimColor,
    interactive = true,
    onPress,
    style,
}: {
    blurIntensity?: number;
    dimColor?: string;
    interactive?: boolean;
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const { theme } = useUnistyles();

    return (
        <Animated.View
            entering={backdropEntering}
            exiting={backdropExiting}
            pointerEvents="box-none"
            style={[StyleSheet.absoluteFill, style]}
        >
            <BlurView
                blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
                blurReductionFactor={2}
                intensity={blurIntensity}
                pointerEvents="none"
                tint={theme.dark ? 'systemMaterialDark' : 'systemMaterialLight'}
                style={StyleSheet.absoluteFill}
            />
            <View
                pointerEvents="none"
                style={[
                    StyleSheet.absoluteFill,
                    {
                        backgroundColor: dimColor ?? (theme.dark
                            ? 'rgba(0, 0, 0, 0.34)'
                            : 'rgba(255, 255, 255, 0.18)'),
                    },
                ]}
            />
            <Pressable
                onPress={onPress}
                pointerEvents={interactive ? 'auto' : 'none'}
                style={StyleSheet.absoluteFill}
            />
        </Animated.View>
    );
}

