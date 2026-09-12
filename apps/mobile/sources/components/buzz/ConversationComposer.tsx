import * as React from 'react';
import * as Haptics from 'expo-haptics';
import {
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  View,
  Platform,
  type NativeSyntheticEvent,
  type GestureResponderEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type Props = {
  value: string;
  placeholder: string;
  height: number;
  maxHeight?: number;
  focused: boolean;
  disabled: boolean;
  attachDisabled?: boolean;
  canSend?: boolean;
  containerProps?: Record<string, unknown>;
  onAttach?(): void;
  onBlur(): void;
  onChangeText(value: string): void;
  onContentSizeChange(event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>): void;
  onFocus(): void;
  onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>): void;
  onSelectionChange?(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>): void;
  onSend(): void;
  /** Only supplied for a server-authorized, current working turn. */
  onStop?(): Promise<boolean>;
  stopKey?: string;
  stopping?: boolean;
  running?: boolean;
  inputRef?: React.Ref<TextInput>;
  testIDPrefix?: string;
};

/** The one text-entry row used by both desktop Room and embedded Corner conversations. */
export function ConversationComposer({
  value,
  placeholder,
  height,
  maxHeight = 160,
  focused,
  disabled,
  attachDisabled = false,
  canSend,
  containerProps,
  onAttach,
  onBlur,
  onChangeText,
  onContentSizeChange,
  onFocus,
  onKeyPress,
  onSelectionChange,
  onSend,
  onStop,
  stopKey,
  stopping = false,
  running = false,
  inputRef,
  testIDPrefix = 'chat',
}: Props) {
  const { theme } = useUnistyles();
  const sendDisabled = disabled || !(canSend ?? Boolean(value.trim()));
  const [armed, setArmed] = React.useState(false);
  const [acting, setActing] = React.useState(false);
  const hold = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = React.useRef(false);
  const cancelledHold = React.useRef(false);
  const busy = React.useRef(false);
  const stopAtHold = React.useRef(stopKey);
  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
    setArmed(false);
  };
  React.useEffect(() => {
    if (hold.current || held.current) cancelledHold.current = true;
    else stopAtHold.current = stopKey;
    held.current = false;
    clearHold();
    return () => {
      if (hold.current) clearTimeout(hold.current);
    };
  }, [stopKey, stopping, Boolean(onStop)]);
  const endPress = (event: GestureResponderEvent) => {
    clearHold();
    const native = event.nativeEvent as typeof event.nativeEvent & { type?: string };
    const type = (native.type ?? event.type ?? '').toLowerCase();
    // Leaving the press target or losing the responder aborts the gesture.
    // A release inside keeps the armed decision for Pressable's onPress.
    if (
      type.includes('move') ||
      type.includes('leave') ||
      type.includes('cancel') ||
      type.includes('terminate') ||
      (native.touches?.length ?? 0) > 0
    )
      held.current = false;
  };
  const press = async () => {
    if (busy.current || disabled || stopping) return;
    if (cancelledHold.current || stopAtHold.current !== stopKey) {
      cancelledHold.current = false;
      held.current = false;
      stopAtHold.current = stopKey;
      return;
    }
    if (!held.current) {
      if (!sendDisabled) onSend();
      return;
    }
    held.current = false;
    if (!onStop || stopAtHold.current !== stopKey) return;
    busy.current = true;
    setActing(true);
    try {
      if (await onStop()) {
        if (!sendDisabled) onSend();
      }
    } finally {
      busy.current = false;
      setActing(false);
    }
  };
  return (
    <View {...containerProps} style={[styles.composer, focused && styles.composerFocused]}>
      <TouchableOpacity
        accessibilityLabel="Attach photo or document"
        accessibilityRole="button"
        disabled={attachDisabled || !onAttach}
        onPress={onAttach}
        style={styles.attachButton}
        testID={`${testIDPrefix}-attach-button`}
      >
        <Text style={styles.attachButtonText}>＋</Text>
      </TouchableOpacity>
      <TextInput
        ref={inputRef}
        style={[styles.input, { height, maxHeight }]}
        value={value}
        onChangeText={onChangeText}
        onContentSizeChange={onContentSizeChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyPress={onKeyPress}
        onSelectionChange={onSelectionChange}
        placeholder={placeholder}
        placeholderTextColor={theme.buzz.dim}
        multiline
        returnKeyType="default"
        scrollEnabled={height >= maxHeight}
        submitBehavior="newline"
        testID={`${testIDPrefix}-input`}
      />
      <Pressable
        accessibilityLabel={armed ? 'Release to stop this turn' : 'Send message'}
        accessibilityHint={
          onStop ? 'Hold for half a second to stop; drag away to cancel' : undefined
        }
        accessibilityRole="button"
        disabled={disabled || stopping || acting || (sendDisabled && !onStop)}
        onPressIn={() => {
          clearHold();
          held.current = false;
          cancelledHold.current = false;
          stopAtHold.current = stopKey;
          // Keep Pressable's release-inside activation: dragging off cancels
          // activation, and re-entering starts a fresh deliberate hold.
          if (!running && !onStop) return;
          hold.current = setTimeout(() => {
            held.current = true;
            if (onStop) {
              setArmed(true);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            }
          }, 500);
        }}
        onPressOut={endPress}
        onPress={() => void press()}
        style={[
          styles.sendButton,
          sendDisabled && !armed && styles.sendButtonDisabled,
          armed && styles.sendButtonArmed,
        ]}
        testID={`${testIDPrefix}-send`}
      >
        {armed ? (
          <>
            <View style={styles.stopSquare} />
            {!sendDisabled && <Text style={styles.sendTick}>↑</Text>}
          </>
        ) : (
          <Text style={styles.sendButtonText}>↑</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  composer: {
    minHeight: 46,
    maxHeight: 126,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgBase,
  },
  composerFocused: {
    borderWidth: 2,
    borderColor: theme.buzz.focus,
    paddingHorizontal: 9,
  },
  attachButton: {
    width: 40,
    height: 40,
    marginLeft: -6,
    marginRight: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButtonText: {
    ...theme.buzz.type.body,
    color: theme.buzz.textMuted,
  },
  input: {
    ...theme.buzz.type.body,
    flex: 1,
    minWidth: 0,
    ...Platform.select({ ios: {}, default: { lineHeight: 20 } }),
    color: theme.buzz.textSecondary,
    minHeight: 40,
    maxHeight: 120,
    paddingVertical: 10,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  sendButton: {
    width: 40,
    height: 40,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.45 },
  sendButtonArmed: { backgroundColor: theme.buzz.accent, borderRadius: theme.buzz.radius },
  stopSquare: {
    width: 11,
    height: 11,
    backgroundColor: theme.buzz.bgBase,
    borderRadius: theme.buzz.radius,
  },
  sendTick: {
    ...theme.buzz.type.meta,
    position: 'absolute',
    right: 0,
    top: -4,
    color: theme.buzz.accent,
    backgroundColor: theme.buzz.bgBase,
    borderColor: theme.buzz.accent,
    borderWidth: 1,
    borderRadius: theme.buzz.radius,
  },
  sendButtonText: {
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
  },
}));
