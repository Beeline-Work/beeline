import * as React from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

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
  inputRef,
  testIDPrefix = 'chat',
}: Props) {
  const { theme } = useUnistyles();
  const sendDisabled = disabled || !(canSend ?? Boolean(value.trim()));
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
        style={styles.input}
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
      <TouchableOpacity
        accessibilityLabel="Send message"
        accessibilityRole="button"
        disabled={sendDisabled}
        onPress={onSend}
        style={[styles.sendButton, sendDisabled && styles.sendButtonDisabled]}
        testID={`${testIDPrefix}-send`}
      >
        <Text style={styles.sendButtonText}>⏎</Text>
      </TouchableOpacity>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
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
    ...Typography.default(),
    color: theme.buzz.textMuted,
    fontSize: 18,
    lineHeight: 22,
  },
  input: {
    ...Typography.default(),
    flex: 1,
    fontSize: 14,
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
  sendButtonDisabled: { backgroundColor: theme.buzz.bgBase },
  sendButtonText: {
    ...Typography.default(),
    color: theme.buzz.textPrimary,
    fontSize: 16,
  },
}));

const styles = stylesheet;
