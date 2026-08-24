import * as React from 'react';
import { 
    View, 
    Text, 
    StyleProp, 
    ViewStyle, 
    TextStyle,
    Platform,
    ActivityIndicator
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BubblePressable } from './BubblePressable';

export interface ItemProps {
    title: string;
    subtitle?: string;
    subtitleLines?: number; // set 0 or undefined for auto/multiline
    detail?: string;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    rightElement?: React.ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    selected?: boolean;
    destructive?: boolean;
    style?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
    detailStyle?: StyleProp<TextStyle>;
    showChevron?: boolean;
    showDivider?: boolean;
    dividerInset?: number;
    pressableStyle?: StyleProp<ViewStyle>;
    copy?: boolean | string;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        minHeight: 56,
    },
    containerWithSubtitle: {
        paddingVertical: 12,
    },
    containerWithoutSubtitle: {
        paddingVertical: 12,
    },
    iconContainer: {
        marginRight: 14,
        width: 24,
        minHeight: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    centerContent: {
        flex: 1,
        justifyContent: 'center',
    },
    title: {
        fontFamily: theme.buzz.proseSemibold,
        fontSize: 16,
        lineHeight: 22,
    },
    titleNormal: {
        color: theme.colors.text,
    },
    titleSelected: {
        color: theme.colors.text,
    },
    titleDestructive: {
        color: theme.colors.textDestructive,
    },
    subtitle: {
        fontFamily: theme.buzz.proseRegular,
        color: theme.buzz.textMuted,
        fontSize: 13,
        lineHeight: 18,
        marginTop: 2,
    },
    rightSection: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 8,
    },
    detail: {
        fontFamily: theme.buzz.monoRegular,
        color: theme.buzz.textMuted,
        fontSize: 12,
    },
    chevron: {
        fontFamily: theme.buzz.monoRegular,
        color: theme.buzz.chrome,
        fontSize: 24,
        lineHeight: 26,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.buzz.border,
    },
    pressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
}));

export const Item = React.memo<ItemProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    
    // Platform-specific measurements
    const isIOS = Platform.OS === 'ios';
    const isAndroid = Platform.OS === 'android';
    const isWeb = Platform.OS === 'web';
    
    // Timer ref for long press copy functionality
    const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const {
        title,
        subtitle,
        subtitleLines,
        detail,
        icon,
        leftElement,
        rightElement,
        onPress,
        onLongPress,
        disabled,
        loading,
        selected,
        destructive,
        style,
        titleStyle,
        subtitleStyle,
        detailStyle,
        showChevron = true,
        showDivider = true,
        dividerInset = isIOS ? 15 : 16,
        pressableStyle,
        copy
    } = props;

    // Handle copy functionality
    const handleCopy = React.useCallback(async () => {
        if (!copy || isWeb) return;
        
        let textToCopy: string;
        
        if (typeof copy === 'string') {
            // If copy is a string, use it directly
            textToCopy = copy;
        } else {
            // If copy is true, try to figure out what to copy
            // Priority: detail > subtitle > title
            textToCopy = detail || subtitle || title;
        }
        
        try {
            await Clipboard.setStringAsync(textToCopy);
            Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: title }));
        } catch (error) {
            console.error('Failed to copy:', error);
        }
    }, [copy, isWeb, title, subtitle, detail]);
    
    // Handle long press for copy functionality
    const handlePressIn = React.useCallback(() => {
        if (copy && !isWeb && !onPress) {
            longPressTimer.current = setTimeout(() => {
                handleCopy();
            }, 500); // 500ms delay for long press
        }
    }, [copy, isWeb, onPress, handleCopy]);
    
    const handlePressOut = React.useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);
    
    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
            }
        };
    }, []);
    
    // If copy is enabled and no onPress is provided, don't set a regular press handler
    // The copy will be handled by long press instead
    const handlePress = onPress;
    
    const isInteractive = handlePress || onLongPress || (copy && !isWeb);
    const showAccessory = isInteractive && showChevron && !rightElement;

    const titleColor = destructive ? styles.titleDestructive : (selected ? styles.titleSelected : styles.titleNormal);
    const containerPadding = subtitle ? styles.containerWithSubtitle : styles.containerWithoutSubtitle;
    
    const content = (
        <>
            <View style={[styles.container, containerPadding, style]}>
                {/* Left Section */}
                {(icon || leftElement) && (
                    <View style={styles.iconContainer}>
                        {leftElement || icon}
                    </View>
                )}

                {/* Center Section */}
                <View style={styles.centerContent}>
                    <Text 
                        style={[styles.title, titleColor, titleStyle]}
                        numberOfLines={subtitle ? 1 : 2}
                    >
                        {title}
                    </Text>
                    {subtitle && (() => {
                        // Allow multiline when requested or when content contains line breaks
                        const effectiveLines = subtitleLines !== undefined
                            ? (subtitleLines <= 0 ? undefined : subtitleLines)
                            : (typeof subtitle === 'string' && subtitle.indexOf('\n') !== -1 ? undefined : 1);
                        return (
                            <Text
                                style={[styles.subtitle, subtitleStyle]}
                                numberOfLines={effectiveLines}
                            >
                                {subtitle}
                            </Text>
                        );
                    })()}
                </View>

                {/* Right Section */}
                <View style={styles.rightSection}>
                    {detail && !rightElement && (
                        <Text 
                            style={[
                                styles.detail, 
                                { marginRight: showAccessory ? 6 : 0 },
                                detailStyle
                            ]}
                            numberOfLines={1}
                        >
                            {detail}
                        </Text>
                    )}
                    {loading && (
                        <ActivityIndicator 
                            size="small" 
                            color={theme.colors.textSecondary}
                            style={{ marginRight: showAccessory ? 6 : 0 }}
                        />
                    )}
                    {rightElement}
                    {showAccessory && (
                        <Text style={[styles.chevron, { marginLeft: 4 }]}>›</Text>
                    )}
                </View>
            </View>

            {/* Divider */}
            {showDivider && (
                <View 
                    style={[
                        styles.divider,
                        { 
                            marginLeft: (isAndroid || isWeb) ? 0 : (dividerInset + (icon || leftElement ? 55 : 16))
                        }
                    ]}
                />
            )}
        </>
    );

    if (isInteractive) {
        return (
            <BubblePressable
                onPress={handlePress}
                onLongPress={onLongPress}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                disabled={disabled || loading}
                bubbleScale={1}
                style={[
                    {
                        backgroundColor: 'transparent',
                        opacity: disabled ? 0.5 : 1
                    },
                    pressableStyle
                ]}
                pressedStyle={isIOS && !isWeb ? styles.pressablePressed : undefined}
                android_ripple={(isAndroid || isWeb) ? {
                    color: theme.colors.surfaceRipple,
                    borderless: false,
                    foreground: true
                } : undefined}
            >
                {content}
            </BubblePressable>
        );
    }

    return <View style={[{ opacity: disabled ? 0.5 : 1 }, pressableStyle]}>{content}</View>;
});
