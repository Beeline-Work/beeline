import React from 'react';
import {
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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
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

type FloatingCallback = (...args: unknown[]) => unknown;

type StablePresentationValue =
  | { kind: 'atomic'; source: unknown; value: unknown }
  | {
      kind: 'function';
      slot: { current: FloatingCallback };
      value: FloatingCallback;
    }
  | { kind: 'array'; entries: readonly StablePresentationValue[]; value: readonly unknown[] }
  | {
      kind: 'element';
      elementKey: React.Key | null;
      elementType: React.ReactElement['type'];
      props: StablePresentationValue;
      value: React.ReactElement;
    }
  | {
      kind: 'record';
      entries: Readonly<Record<string, StablePresentationValue>>;
      value: Readonly<Record<string, unknown>>;
    };

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reconcile one floating presentation by visible value, not allocation identity.
 * React event callback slots stay live even when the rendered tree keeps its
 * prior identity. Render/style functions remain presentation-significant.
 */
function reconcilePresentationValue(
  previous: StablePresentationValue | undefined,
  next: unknown,
  propertyKey?: string,
): StablePresentationValue {
  const isEventCallback = propertyKey === 'ref' || /^on[A-Z]/.test(propertyKey ?? '');
  if (typeof next === 'function' && isEventCallback) {
    const latest = next as FloatingCallback;
    if (previous?.kind === 'function') {
      previous.slot.current = latest;
      return previous;
    }
    const slot: { current: FloatingCallback } = { current: latest };
    const value = function (this: unknown, ...args: unknown[]) {
      return slot.current.apply(this, args);
    };
    const stable: StablePresentationValue = {
      kind: 'function',
      slot,
      value,
    };
    return stable;
  }

  if (React.isValidElement(next)) {
    const element = next as React.ReactElement<Record<string, unknown>>;
    const previousElement =
      previous?.kind === 'element' &&
      previous.elementType === element.type &&
      previous.elementKey === element.key
        ? previous
        : undefined;
    const props = reconcilePresentationValue(previousElement?.props, element.props);
    if (previousElement && props === previousElement.props) return previousElement;
    return {
      kind: 'element',
      elementKey: element.key,
      elementType: element.type,
      props,
      value: React.cloneElement(element, props.value as Record<string, unknown>),
    };
  }

  if (Array.isArray(next)) {
    const previousArray = previous?.kind === 'array' ? previous : undefined;
    const entries = next.map((value, index) =>
      reconcilePresentationValue(previousArray?.entries[index], value, propertyKey),
    );
    if (
      previousArray &&
      entries.length === previousArray.entries.length &&
      entries.every((entry, index) => entry === previousArray.entries[index])
    ) {
      return previousArray;
    }
    return {
      kind: 'array',
      entries,
      value: entries.map((entry, index) =>
        React.isValidElement(entry.value) && entry.value.key === null
          ? React.cloneElement(entry.value, { key: `floating-presentation-${index}` })
          : entry.value,
      ),
    };
  }

  if (next !== null && typeof next === 'object' && isPlainRecord(next)) {
    const previousRecord = previous?.kind === 'record' ? previous : undefined;
    const keys = Object.keys(next);
    const entries: Record<string, StablePresentationValue> = {};
    let unchanged = Boolean(
      previousRecord && keys.length === Object.keys(previousRecord.entries).length,
    );
    for (const key of keys) {
      const entry = reconcilePresentationValue(previousRecord?.entries[key], next[key], key);
      entries[key] = entry;
      unchanged = unchanged && entry === previousRecord?.entries[key];
    }
    if (previousRecord && unchanged) return previousRecord;
    return {
      kind: 'record',
      entries,
      value: Object.fromEntries(keys.map((key) => [key, entries[key]!.value])),
    };
  }

  if (previous?.kind === 'atomic' && Object.is(previous.source, next)) return previous;
  return { kind: 'atomic', source: next, value: next };
}

function useStableFloatingPresentation(props: HullModalProps): HullModalProps {
  const presentation = React.useRef<StablePresentationValue | undefined>(undefined);
  presentation.current = reconcilePresentationValue(presentation.current, props);
  return presentation.current.value as HullModalProps;
}

/**
 * The only React Native Modal boundary owned by Beeline. Every app-rendered
 * floating surface gets the same scrim, keyboard behavior, platform-back
 * semantics, and accessibility isolation before choosing its HullSurface
 * content shape.
 */
const StableHullModal = React.memo(function StableHullModal({
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
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
});

/**
 * Every floating member crosses this one identity boundary. A churning host can
 * refresh callback closures without asking React Native to lay out the mounted
 * Modal again; a visible prop or presentation-value change still renders.
 */
export function HullModal(props: HullModalProps) {
  const presentation = useStableFloatingPresentation(props);
  return <StableHullModal {...presentation} />;
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
