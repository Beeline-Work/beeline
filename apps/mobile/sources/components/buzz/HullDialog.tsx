import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullSurface } from './MonoHull';

export type HullDialogAction = {
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
  variant?: 'quiet' | 'primary' | 'destructive';
};

type HullFloatingSurfaceProps = Omit<React.ComponentProps<typeof HullSurface>, 'strength'>;

/** The single tokenized surface base for every app-owned floating region. */
export function HullFloatingSurface({ style, ...props }: HullFloatingSurfaceProps) {
  return <HullSurface {...props} strength="raised" style={[styles.floatingSurface, style]} />;
}

type HullModalProps = {
  accessibilityLabel?: string;
  animationType?: 'fade' | 'slide' | 'none';
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  dismissOnBackdrop?: boolean;
  keyboardAvoiding?: boolean;
  onRequestClose: () => void;
  placement?: 'bottom' | 'center' | 'fill';
  scrimTestID?: string;
  testID?: string;
  visible: boolean;
};

/**
 * The only React Native Modal boundary owned by Beeline. Every app-rendered
 * floating surface gets the same scrim, keyboard behavior, platform-back
 * semantics, and accessibility isolation before choosing its HullSurface
 * content shape.
 */
export function HullModal({
  accessibilityLabel = 'Close dialog',
  animationType = 'fade',
  children,
  contentStyle,
  dismissOnBackdrop = true,
  keyboardAvoiding = true,
  onRequestClose,
  placement = 'center',
  scrimTestID,
  testID,
  visible,
}: HullModalProps) {
  return (
    <Modal
      animationType={animationType}
      navigationBarTranslucent
      onRequestClose={onRequestClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        enabled={keyboardAvoiding}
        style={[
          styles.modalRoot,
          placement === 'center' && styles.modalRootCenter,
          placement === 'bottom' && styles.modalRootBottom,
        ]}
        testID={testID}
      >
        {dismissOnBackdrop ? (
          <Pressable
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="button"
            onPress={onRequestClose}
            style={styles.scrim}
            testID={scrimTestID}
          />
        ) : (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.scrim}
          />
        )}
        <View
          accessibilityViewIsModal
          style={[
            styles.modalContent,
            placement === 'center' && styles.modalContentCenter,
            placement === 'bottom' && styles.modalContentBottom,
            placement === 'fill' && styles.modalContentFill,
            contentStyle,
          ]}
        >
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type HullDialogProps = Omit<HullModalProps, 'children' | 'placement'> & {
  actions: readonly HullDialogAction[];
  body?: string;
  children?: React.ReactNode;
  surfaceStyle?: StyleProp<ViewStyle>;
  title: string;
};

/** Centered confirm/alert/input member of the floating Hull family. */
export function HullDialog({
  actions,
  body,
  children,
  surfaceStyle,
  title,
  testID,
  ...modalProps
}: HullDialogProps) {
  const primaryIndex = actions.findIndex((action) => action.variant === 'primary');
  return (
    <HullModal {...modalProps} placement="center" testID={testID}>
      <HullFloatingSurface style={[styles.dialogSurface, surfaceStyle]}>
        <View style={styles.dialogCopy}>
          <Text accessibilityRole="header" style={styles.dialogTitle}>
            {title}
          </Text>
          {body ? <Text style={styles.dialogBody}>{body}</Text> : null}
          {children}
        </View>
        <View style={styles.dialogActions}>
          {actions.map((action, index) => {
            const isPrimary = index === primaryIndex;
            return (
              <Pressable
                accessibilityLabel={action.accessibilityLabel ?? action.label}
                accessibilityRole="button"
                accessibilityState={{
                  busy: action.busy === true,
                  disabled: action.disabled === true,
                }}
                disabled={action.disabled}
                key={`${action.testID ?? action.label}:${action.variant ?? 'quiet'}`}
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.dialogAction,
                  isPrimary && styles.dialogActionPrimary,
                  pressed && styles.dialogActionPressed,
                  action.disabled && styles.dialogActionDisabled,
                ]}
                testID={action.testID}
              >
                <Text
                  style={[
                    styles.dialogActionText,
                    isPrimary && styles.dialogActionPrimaryText,
                    action.variant === 'destructive' && styles.dialogActionDestructiveText,
                    action.disabled && styles.dialogActionDisabledText,
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </HullFloatingSurface>
    </HullModal>
  );
}

export const HullDialogInput = React.forwardRef<TextInput, TextInputProps>(function HullDialogInput(
  { style, ...props },
  ref,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.inputRule}>
      <TextInput
        {...props}
        ref={ref}
        placeholderTextColor={props.placeholderTextColor ?? theme.buzz.textDisabled}
        style={[styles.input, style]}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    modalRoot: { flex: 1, minWidth: 0 },
    modalRootCenter: { alignItems: 'center', justifyContent: 'center', padding: 24 },
    modalRootBottom: { alignItems: 'center', justifyContent: 'flex-end' },
    scrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: hull.bgTerminal,
      opacity: 0.82,
    },
    modalContent: { zIndex: 1, minWidth: 0 },
    modalContentCenter: { width: '100%', maxWidth: 460 },
    modalContentBottom: { width: '100%', maxWidth: 600 },
    modalContentFill: { flex: 1, width: '100%' },
    floatingSurface: {
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
      backgroundColor: hull.bgRaised,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.55,
      shadowRadius: 48,
      elevation: 18,
    },
    dialogSurface: { width: '100%' },
    dialogCopy: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 16 },
    dialogTitle: {
      ...Typography.default('semiBold'),
      fontFamily: hull.proseSemibold,
      color: hull.textPrimary,
      fontSize: 16,
      lineHeight: 22,
    },
    dialogBody: {
      ...Typography.default(),
      fontFamily: hull.proseRegular,
      marginTop: 8,
      color: hull.textSecondary,
      fontSize: 14,
      lineHeight: 21,
    },
    dialogActions: {
      minHeight: 58,
      paddingHorizontal: 12,
      paddingVertical: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    dialogAction: {
      minWidth: 44,
      minHeight: 44,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
    },
    dialogActionPrimary: { backgroundColor: hull.accent },
    dialogActionPressed: { opacity: 0.78, backgroundColor: hull.bgPressed },
    dialogActionDisabled: { opacity: 0.42 },
    dialogActionText: {
      ...Typography.mono('semiBold'),
      color: hull.chrome,
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    dialogActionPrimaryText: { color: hull.textInverted },
    dialogActionDestructiveText: { color: hull.dialogDanger },
    dialogActionDisabledText: { color: hull.textDisabled },
    inputRule: {
      width: '100%',
      marginTop: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.borderStrong,
    },
    input: {
      ...Typography.default(),
      fontFamily: hull.proseRegular,
      minHeight: 44,
      paddingHorizontal: 0,
      paddingVertical: 8,
      color: hull.textPrimary,
      fontSize: 15,
    },
  };
});
