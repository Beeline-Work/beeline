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
import { groknight } from '@/buzz/groknight';

type Props = {
  value: string;
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
  reply?: {
    handle: string;
    preview: string;
  };
  onCancelReply?(): void;
  attachments?: readonly {
    uri: string;
    name: string;
    mimeType: string;
    sizeLabel: string;
  }[];
  attachmentsUploading?: boolean;
  onRemoveAttachment?(index: number): void;
};

export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26;
export const COMPOSER_MAX_INPUT_HEIGHT = 5 * groknight.type.body.lineHeight;

/** The one text-entry row used by both desktop Room and embedded Corner conversations. */
export function ConversationComposer({
  value,
  height,
  maxHeight = 120,
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
  reply,
  onCancelReply,
  attachments = [],
  attachmentsUploading = false,
  onRemoveAttachment,
}: Props) {
  const { theme } = useUnistyles();
  const sendDisabled = disabled || !(canSend ?? Boolean(value.trim()));
  const multiline = height > COMPOSER_SINGLE_LINE_INPUT_HEIGHT;
  const [armed, setArmed] = React.useState(false);
  const [acting, setActing] = React.useState(false);
  const hold = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = React.useRef(false);
  const cancelledHold = React.useRef(false);
  const busy = React.useRef(false);
  const stopAtHold = React.useRef(stopKey);
  const visibleAttachments = attachments.slice(0, 3);
  const hiddenAttachmentCount = Math.max(0, attachments.length - visibleAttachments.length);
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
      {(reply || attachments.length > 0) && (
        <View style={styles.adjuncts} testID={`${testIDPrefix}-composer-adjuncts`}>
          {reply && (
            <View style={styles.reply} testID="reply-composer-banner">
              <View style={styles.replyCopy}>
                <Text numberOfLines={1} style={styles.replyLabel}>
                  <Text style={styles.replyGlyph}>↩</Text> Replying to{' '}
                  <Text style={styles.replyHandle}>@{reply.handle}</Text>
                </Text>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.replyPreview}>
                  {reply.preview}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel="Cancel reply"
                accessibilityRole="button"
                onPress={onCancelReply}
                style={styles.removeButton}
                testID="reply-composer-cancel"
              >
                <Text style={styles.removeButtonText}>×</Text>
              </TouchableOpacity>
            </View>
          )}
          {visibleAttachments.map((attachment, index) => (
            <View
              key={`${attachment.uri}:${index}`}
              style={[styles.attachment, (reply || index > 0) && styles.adjunctDivider]}
              testID={`pending-chat-attachment-${index}`}
            >
              <View style={styles.attachmentCopy}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.attachmentName}>
                  {attachment.name}
                </Text>
                <Text numberOfLines={1} style={styles.attachmentMeta}>
                  {attachmentsUploading ? 'UPLOADING' : attachment.sizeLabel} ·{' '}
                  {attachment.mimeType.toUpperCase()}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel={`Remove ${attachment.name}`}
                accessibilityRole="button"
                disabled={attachmentsUploading}
                onPress={() => onRemoveAttachment?.(index)}
                style={styles.removeButton}
                testID={`pending-chat-attachment-remove-${index}`}
              >
                <Text style={styles.removeButtonText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
          {hiddenAttachmentCount > 0 && (
            <View
              style={[styles.moreAttachments, styles.adjunctDivider]}
              testID="pending-chat-attachments-more"
            >
              <Text style={styles.moreAttachmentsText}>{hiddenAttachmentCount} more</Text>
            </View>
          )}
        </View>
      )}
      <View
        style={[styles.inputRow, multiline && styles.composerMultiline]}
        testID={`${testIDPrefix}-composer-input-row`}
      >
        <TouchableOpacity
          accessibilityLabel="Attach photo or document"
          accessibilityRole="button"
          disabled={attachDisabled || !onAttach}
          hitSlop={9}
          onPress={onAttach}
          style={styles.attachButton}
          testID={`${testIDPrefix}-attach-button`}
        >
          <Text style={styles.attachButtonText}>＋</Text>
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
          style={[styles.input, Platform.OS === 'ios' ? undefined : { height, maxHeight }]}
          value={value}
          onChangeText={onChangeText}
          onContentSizeChange={onContentSizeChange}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyPress={onKeyPress}
          onSelectionChange={onSelectionChange}
          placeholder="Message"
          placeholderTextColor={theme.buzz.dim}
          // Android otherwise adds an asymmetric font inset inside the field,
          // on top of the row's shared vertical padding.
          includeFontPadding={Platform.OS === 'android' ? false : undefined}
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
          hitSlop={9}
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
          style={[styles.sendButton, armed && styles.sendButtonArmed]}
          testID={`${testIDPrefix}-send`}
        >
          {armed ? (
            <>
              <View style={styles.stopSquare} />
              {!sendDisabled && <Text style={styles.sendTick}>↑</Text>}
            </>
          ) : (
            <Text style={[styles.sendButtonText, sendDisabled && styles.sendButtonTextDisabled]}>
              ↑
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  composer: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgRaised,
    overflow: 'hidden',
  },
  inputRow: {
    minHeight: 42,
    maxHeight: COMPOSER_MAX_INPUT_HEIGHT + 18,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  composerMultiline: { alignItems: 'flex-end' },
  composerFocused: {
    borderColor: theme.buzz.accent,
  },
  adjuncts: { borderBottomWidth: 1, borderBottomColor: theme.buzz.border },
  adjunctDivider: { borderTopWidth: 1, borderTopColor: theme.buzz.border },
  reply: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
  },
  replyCopy: { flex: 1, minWidth: 0, paddingVertical: 10 },
  replyLabel: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  replyGlyph: { color: theme.buzz.accent },
  replyHandle: { color: theme.buzz.accent },
  replyPreview: {
    ...theme.buzz.type.meta,
    marginTop: 2,
    color: theme.buzz.textSecondary,
  },
  attachment: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
  },
  attachmentCopy: { flex: 1, minWidth: 0 },
  attachmentName: {
    ...theme.buzz.type.body,
    fontSize: theme.buzz.transcriptCard.rowTitleSize,
    color: theme.buzz.textPrimary,
  },
  attachmentMeta: {
    ...theme.buzz.type.machine,
    fontSize: theme.buzz.transcriptCard.rowKindSize,
    color: theme.buzz.ledgerGhost,
  },
  removeButton: {
    width: 44,
    minHeight: 44,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  moreAttachments: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 16 },
  moreAttachmentsText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  attachButton: {
    width: 26,
    height: 26,
    marginRight: 8,
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
    minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
    maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    paddingVertical: 0,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  sendButton: {
    width: 26,
    height: 26,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  sendButtonTextDisabled: { color: theme.buzz.textMuted },
}));
