import { useFinePointer } from '@/utils/use-fine-pointer';
import * as React from 'react';
import * as Native from 'react-native';
import type { BeelineThemeTokens } from '@/buzz/groknight';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  Text,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Haptics from 'expo-haptics';
import { PixelLoader } from './MonoHull';

export type ButtonVariant =
  'primary' | 'secondary' | 'provider' | 'brass' | 'quiet' | 'destructive' | 'danger';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  ref?: React.Ref<React.ComponentRef<typeof Pressable>>;
  /** Sentence-case verb shown on the button. */
  label: string;
  /** Provider-free recovery when the styling runtime itself failed. */
  emergencyTheme?: BeelineThemeTokens;
  /** Existing drawn glyph for an icon-only control, with an accessibility label. */
  icon?: React.ReactNode;
  /** Fixed 44-point target without label padding. */
  iconOnly?: boolean;
  /** Compact filters for a mouse; touch keeps the house target. */
  compact?: boolean;
  iconPosition?: 'start' | 'end';
  /**
   * `primary`: the filled action (one per surface).
   * `secondary`: outlined in `borderStrong`, for the alternative action.
   * `provider`: white surface for account sign-in providers in either theme.
   * `brass`: outlined in the accent, for a highlighted secondary action.
   */
  variant?: ButtonVariant;
  /** Recedes a dismissal label without changing its control or hit target. */
  labelTone?: 'quiet';
  /** Shows the compact pixel loader, marks the button busy and disables it. */
  loading?: boolean;
  /** Stretch across the parent's cross axis. */
  fullWidth?: boolean;
  /** Preserve an existing approved control while moving its behavior into Button. */
  appearance?: {
    control?: PressableProps['style'];
    label?: StyleProp<TextStyle>;
  };
  /** Outer layout only (margins, alignment, flex). Shape and type are fixed. */
  style?: StyleProp<ViewStyle>;
  /** Label layout only; shape and type remain fixed. */
  labelStyle?: StyleProp<Pick<TextStyle, 'flexGrow' | 'textAlign'>>;
};

/**
 * The one button (DESIGN.md → Buttons). House radius, 44 tall, `body` label in
 * Space Grotesk Medium. Replaces MonoButton, BrassButton, OnboardingButton and
 * RoundButton.
 */
export function Button(props: ButtonProps) {
  return props.emergencyTheme ? <RecoveryButton {...props} /> : <ButtonFrame {...props} />;
}

/** No styling-runtime hooks run on the recovery path. */
function RecoveryButton({
  label,
  emergencyTheme,
  icon,
  iconOnly = false,
  compact = false,
  iconPosition = 'start',
  variant = 'primary',
  labelTone,
  loading = false,
  fullWidth = false,
  disabled,
  style,
  labelStyle,
  appearance,
  onPress,
  accessibilityState,
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  if (emergencyTheme) {
    const { Pressable: EmergencyPressable, Text: EmergencyText } = Native;
    return (
      <EmergencyPressable
        {...props}
        accessibilityRole="button"
        accessibilityState={{ ...accessibilityState, disabled: isDisabled }}
        disabled={isDisabled}
        onPress={onPress}
        style={(state) =>
          appearance
            ? [
                typeof appearance.control === 'function'
                  ? appearance.control(state)
                  : appearance.control,
                style,
              ]
            : [
                {
                  minHeight: 44,
                  minWidth: 44,
                  paddingHorizontal: emergencyTheme.space.md,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: emergencyTheme.radius,
                },
                style,
              ]
        }
      >
        <EmergencyText
          style={
            appearance
              ? appearance.label
              : { ...emergencyTheme.type.bodyStrong, color: emergencyTheme.accent }
          }
        >
          {label}
        </EmergencyText>
      </EmergencyPressable>
    );
  }
  return null;
}

function ButtonFrame({
  label,
  emergencyTheme,
  icon,
  iconOnly = false,
  compact = false,
  iconPosition = 'start',
  variant = 'primary',
  labelTone,
  loading = false,
  fullWidth = false,
  disabled,
  style,
  labelStyle,
  appearance,
  onPress,
  accessibilityState,
  ...props
}: ButtonProps) {
  const finePointer = useFinePointer();
  const isDisabled = Boolean(disabled || loading);
  const primary = variant === 'primary';
  const filled = primary || variant === 'provider';
  const borderless = variant === 'quiet' || variant === 'destructive';
  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      accessibilityState={{
        ...accessibilityState,
        disabled: isDisabled,
        busy: loading || accessibilityState?.busy === true,
      }}
      disabled={isDisabled}
      onPress={(event) => {
        if (primary) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(event);
      }}
      style={(state) =>
        appearance
          ? [
              typeof appearance.control === 'function'
                ? appearance.control(state)
                : appearance.control,
              style,
            ]
          : [
              styles.frame,
              compact && finePointer && styles.compact,
              primary ? styles.primary : styles[variant],
              state.pressed &&
                !isDisabled &&
                (filled ? styles.primaryPressed : styles.outlinedPressed),
              isDisabled &&
                (primary
                  ? styles.primaryDisabled
                  : variant === 'provider'
                    ? styles.providerDisabled
                    : !borderless && styles.outlinedDisabled),
              fullWidth && styles.fullWidth,
              iconOnly && styles.iconOnly,
              style,
            ]
      }
    >
      {loading && <PixelLoader compact />}
      {iconPosition === 'start' && icon}
      {label ? (
        <Text
          numberOfLines={appearance ? undefined : 1}
          style={[
            ...(appearance
              ? [appearance.label]
              : [
                  styles.label,
                  labelStyle,
                  primary
                    ? styles.primaryLabel
                    : variant === 'provider'
                      ? styles.providerLabel
                      : variant === 'brass'
                        ? styles.brassLabel
                        : variant === 'danger'
                          ? styles.dangerLabel
                          : variant === 'destructive'
                            ? styles.destructiveLabel
                            : styles.secondaryLabel,
                  labelTone === 'quiet' && styles.quietLabel,
                  isDisabled && variant !== 'provider' && styles.disabledLabel,
                ]),
          ]}
        >
          {label}
        </Text>
      ) : null}
      {iconPosition === 'end' && icon}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const buzz = theme.buzz;
  return {
    frame: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: buzz.space.md,
      borderRadius: buzz.radius,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: buzz.space.sm,
    },
    compact: { minHeight: 32 },
    iconOnly: { width: 44, height: 44, paddingHorizontal: 0 },
    primary: { backgroundColor: buzz.buttonPrimaryFill, borderColor: buzz.buttonPrimaryFill },
    provider: { backgroundColor: buzz.buttonProviderFill, borderColor: buzz.buttonProviderFill },
    providerLabel: { color: buzz.buttonProviderText },
    secondary: { backgroundColor: 'transparent', borderColor: buzz.borderStrong },
    brass: { backgroundColor: 'transparent', borderColor: buzz.accent },
    quiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
    destructive: { backgroundColor: 'transparent', borderColor: 'transparent' },
    danger: { backgroundColor: 'transparent', borderColor: buzz.dialogDanger },
    dangerLabel: { color: buzz.textPrimary },
    destructiveLabel: { color: buzz.dialogDanger },
    primaryPressed: { opacity: 0.85 },
    outlinedPressed: { backgroundColor: buzz.bgPressed },
    primaryDisabled: { backgroundColor: buzz.bgPressed, borderColor: buzz.bgPressed },
    providerDisabled: { opacity: 0.4 },
    outlinedDisabled: { borderColor: buzz.border },
    fullWidth: { alignSelf: 'stretch' },
    label: { ...buzz.type.body, fontFamily: buzz.proseMedium },
    primaryLabel: { color: buzz.buttonPrimaryText },
    quietLabel: { ...buzz.type.body, color: buzz.textSecondary },
    secondaryLabel: { color: buzz.buttonSecondaryText },
    brassLabel: { color: buzz.accent },
    disabledLabel: { color: buzz.textDisabled },
  };
});
