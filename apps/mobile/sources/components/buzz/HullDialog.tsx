import React from 'react';
import {
  Modal,
  StyleSheet as NativeStyleSheet,
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
import { typeRoles } from '@/buzz/groknight';
import { Button, type ButtonProps } from './Button';
import { HullSurface } from './MonoHull';

export type HullDialogAction = {
  accessibilityLabel?: string;
  accessibilityRole?: ButtonProps['accessibilityRole'];
  description?: React.ReactNode;
  busy?: boolean;
  loading?: boolean;
  disabled?: boolean;
  label: string;
  onPress: NonNullable<ButtonProps['onPress']>;
  testID?: string;
  variant?: 'quiet' | 'primary' | 'destructive';
};

export const HULL_DIALOG_LAYOUT = {
  actionBorderTopWidth: StyleSheet.hairlineWidth,
  actionButtonMinHeight: 44,
  actionPaddingVertical: 8,
  // dialogBody reads the meta role; dialogTitle reads bodyStrong — this
  // geometry budget (`hullDialogMinimumHeight`) must use their real line
  // heights, not an approximation, or the two drift apart.
  bodyLineHeight: typeRoles.meta.lineHeight,
  bodyMarginTop: 8,
  copyPaddingBottom: 16,
  copyPaddingTop: 24,
  inputMarginTop: 16,
  inputMinHeight: 44,
  titleLineHeight: typeRoles.bodyStrong.lineHeight,
} as const;

export function hullDialogActionsMinimumHeight() {
  return (
    HULL_DIALOG_LAYOUT.actionButtonMinHeight +
    HULL_DIALOG_LAYOUT.actionPaddingVertical * 2 +
    HULL_DIALOG_LAYOUT.actionBorderTopWidth
  );
}

export function hullDialogMinimumHeight(contentHeight: number, includesBody: boolean) {
  return (
    hullDialogActionsMinimumHeight() +
    HULL_DIALOG_LAYOUT.copyPaddingTop +
    HULL_DIALOG_LAYOUT.copyPaddingBottom +
    HULL_DIALOG_LAYOUT.titleLineHeight +
    contentHeight +
    (includesBody ? HULL_DIALOG_LAYOUT.bodyMarginTop + HULL_DIALOG_LAYOUT.bodyLineHeight : 0)
  );
}

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
  onDismiss?: () => void;
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

/**
 * Whether this reconciler can REBUILD the object faithfully — which is the only
 * thing it ever does with a record: `Object.fromEntries(Object.keys(...))`, a
 * copy that can carry nothing but enumerable string-keyed own properties.
 *
 * A Unistyles style is the counter-example, and the reason this question has to
 * be asked at all. `StyleSheet.create` returns the parsed properties plus one
 * enumerable `unistyles_<hash>` key holding the style's C++ handle, and every
 * member of that handle — `uni__getStyles` among them — is defined
 * `enumerable: false` (`cxx/common/Helpers.h → defineHiddenProperty`). Copying
 * it by its enumerable keys therefore yields `{}`: the key survives, the handle
 * inside it does not. Most Unistyles components then recover through the C++
 * hash-key fallback, but the `Pressable` wrapper reads the handle from JS and
 * calls `style[unistyles_<hash>].uni__getStyles()`, so an emptied handle
 * crashed the render outright — the Room member picker's candidate rows are
 * the app's one `Pressable` with an object `style` mounted as HullModal
 * children, so opening that picker was the one place it fired.
 *
 * An object this cannot reproduce is passed through by identity instead
 * (the atomic branch), which is both correct and no less stable: a style object
 * is allocated once by `StyleSheet.create` and is the same reference on every
 * render, so `Object.is` keeps reusing it.
 */
function isRebuildableRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.getOwnPropertyNames(value).length === Object.keys(value).length;
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

  if (next !== null && typeof next === 'object' && isRebuildableRecord(next)) {
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
  onDismiss,
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
      onDismiss={onDismiss}
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
  contentLayout?: 'intrinsic' | 'fill';
  surfaceStyle?: StyleProp<ViewStyle>;
  title: string;
};

/** Centered confirm/alert/input member of the floating Hull family. */
export function HullDialog({
  actions,
  body,
  children,
  contentLayout = 'intrinsic',
  surfaceStyle,
  title,
  testID,
  ...modalProps
}: HullDialogProps) {
  const primaryIndex = actions.findIndex((action) => action.variant === 'primary');
  return (
    <HullModal {...modalProps} placement="center" testID={testID}>
      <HullFloatingSurface style={[styles.dialogSurface, surfaceStyle]}>
        <View style={[styles.dialogCopy, contentLayout === 'fill' && styles.dialogCopyFill]}>
          <Text accessibilityRole="header" style={styles.dialogTitle}>
            {title}
          </Text>
          {body ? <Text style={styles.dialogBody}>{body}</Text> : null}
          {children ? (
            <View
              style={[styles.dialogContent, contentLayout === 'fill' && styles.dialogContentFill]}
            >
              {children}
            </View>
          ) : null}
        </View>
        <HullDialogActions
          actions={actions.map((action, index) =>
            action.variant === 'primary' && index !== primaryIndex
              ? { ...action, variant: 'quiet' as const }
              : action,
          )}
          style={styles.dialogActions}
        />
      </HullFloatingSurface>
    </HullModal>
  );
}

/** Shared trailing decision row, used by dialogs, sheet forms and inline decisions. */
export function HullDialogActions({
  actions,
  style,
}: {
  actions: readonly HullDialogAction[];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.actionRow, style]}>
      {actions.map((action) => (
        <View
          key={`${action.testID ?? action.label}:${action.variant ?? 'quiet'}`}
          style={styles.actionSlot}
        >
          <Button
            {...(action.accessibilityRole ? { accessibilityRole: action.accessibilityRole } : {})}
            label={action.label}
            variant={action.variant ?? 'quiet'}
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityState={{ busy: action.busy === true }}
            loading={action.loading}
            disabled={action.disabled}
            onPress={action.onPress}
            testID={action.testID}
          />
          {action.description}
        </View>
      ))}
    </View>
  );
}

export const HullDialogInput = React.forwardRef<
  TextInput,
  TextInputProps & { ruleStyle?: StyleProp<ViewStyle> }
>(function HullDialogInput({ style, ruleStyle, ...props }, ref) {
  const { theme } = useUnistyles();
  // Layout belongs to the wrapper; the native field owns only its shared type
  // and underline geometry. Keep flex/margins at existing row/search callers.
  const [focused, setFocused] = React.useState(false);
  const resolvedStyle = NativeStyleSheet.flatten(style) ?? {};
  const layoutKeys = [
    'flex',
    'flexGrow',
    'flexShrink',
    'flexBasis',
    'alignSelf',
    'width',
    'minWidth',
    'maxWidth',
    'margin',
    'marginHorizontal',
    'marginVertical',
    'marginTop',
    'marginBottom',
    'marginLeft',
    'marginRight',
  ] as const;
  const outerStyle: ViewStyle = {};
  const innerStyle = { ...resolvedStyle };
  for (const key of layoutKeys) {
    if (key in resolvedStyle) (outerStyle as Record<string, unknown>)[key] = resolvedStyle[key];
    delete innerStyle[key];
  }
  return (
    <View style={[styles.inputRule, outerStyle, ruleStyle, focused && styles.inputFocused]}>
      <TextInput
        {...props}
        ref={ref}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        placeholderTextColor={props.placeholderTextColor ?? theme.buzz.textDisabled}
        style={[innerStyle, styles.input, props.multiline && styles.multilineInput]}
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
      shadowColor: hull.dialogShadowColor,
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: hull.dialogShadowOpacity,
      shadowRadius: 48,
      elevation: 18,
    },
    dialogSurface: { width: '100%' },
    dialogCopy: {
      flexShrink: 1,
      minHeight: 0,
      overflow: 'hidden',
      paddingHorizontal: hull.space.lg,
      paddingTop: HULL_DIALOG_LAYOUT.copyPaddingTop,
      paddingBottom: HULL_DIALOG_LAYOUT.copyPaddingBottom,
    },
    dialogCopyFill: { flex: 1 },
    dialogContent: { flexShrink: 1, minHeight: 0 },
    dialogContentFill: { flex: 1 },
    dialogTitle: {
      ...hull.type.bodyStrong,
      color: hull.textPrimary,
      lineHeight: HULL_DIALOG_LAYOUT.titleLineHeight,
    },
    dialogBody: {
      ...hull.type.meta,
      marginTop: HULL_DIALOG_LAYOUT.bodyMarginTop,
      color: hull.textSecondary,
      lineHeight: HULL_DIALOG_LAYOUT.bodyLineHeight,
    },
    dialogActions: {
      flexShrink: 0,
      minHeight: hullDialogActionsMinimumHeight(),
      paddingHorizontal: hull.space.sm,
      paddingVertical: HULL_DIALOG_LAYOUT.actionPaddingVertical,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: hull.space.sm,
      borderTopWidth: HULL_DIALOG_LAYOUT.actionBorderTopWidth,
      borderTopColor: hull.border,
    },
    actionSlot: { flexShrink: 1 },
    actionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: hull.space.sm,
    },
    inputRule: {
      alignSelf: 'stretch',
      marginTop: HULL_DIALOG_LAYOUT.inputMarginTop,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.borderStrong,
    },
    inputFocused: { borderBottomColor: hull.accent },
    input: {
      ...hull.type.body,
      minHeight: HULL_DIALOG_LAYOUT.inputMinHeight,
      paddingHorizontal: 0,
      paddingVertical: 8,
      color: hull.textPrimary,
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderBottomWidth: 0,
      borderTopWidth: 0,
      borderLeftWidth: 0,
      borderRightWidth: 0,
      borderRadius: hull.radius,
      height: undefined,
      ...(Platform.OS === 'web' ? { outlineStyle: 'solid' as const, outlineWidth: 0 } : {}),
      textAlign: 'left',
      fontWeight: 'normal',
    },
    multilineInput: { minHeight: 120, textAlignVertical: 'top' },
  };
});
