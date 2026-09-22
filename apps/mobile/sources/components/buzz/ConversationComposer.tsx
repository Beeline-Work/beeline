import * as React from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  View,
  Linking,
  Platform,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { groknight } from '@/buzz/groknight';
import { MicGlyph } from './MicGlyph';
import { useSpeechInput } from '@/buzz/speech-input';

type Props = {
  value: string;
  height: number;
  maxHeight?: number;
  focused: boolean;
  disabled: boolean;
  attachDisabled?: boolean;
  canSend?: boolean;
  containerProps?: Record<string, unknown>;
  /**
   * react-native-web's View only forwards a fixed allowlist of DOM props
   * (clicks, pointers, keys, focus) to its underlying element, silently
   * dropping `onPaste` passed through `containerProps` — a real Ctrl+V never
   * reaches it. This is wired straight onto the container node instead.
   */
  onDesktopPaste?(event: ClipboardEvent): void;
  onAttach?(): void;
  onBlur(): void;
  onChangeText(value: string): void;
  onContentSizeChange(event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>): void;
  onFocus(): void;
  onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>): void;
  onSelectionChange?(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>): void;
  onSend(): void;
  /**
   * Speech recognition is always available when the hook can use the native
   * platform recogniser. Pass `false` to disable it (e.g. when the parent
   * environment already tested availability).
   */
  speechEnabled?: boolean;
  /**
   * Only supplied for a server-authorized, current working turn. The plain
   * tap-to-send composer takes no stop gesture of its own — the stop control
   * lives on `TurnProgressLine` — so this stays an accepted no-op kept for
   * the shared Room/corner call-site shape.
   */
  onStop?(): Promise<boolean>;
  inputRef?: React.Ref<TextInput>;
  /**
   * Changes when the parent consumes the current draft. The native input is
   * replaced so platform-owned text cannot survive a successful send, and
   * change callbacks identify the input generation that emitted them.
   */
  inputRevision?: number;
  isInputRevisionCurrent?(inputRevision: number): boolean;
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
  onDesktopPaste,
  onAttach,
  onBlur,
  onChangeText,
  onContentSizeChange,
  onFocus,
  onKeyPress,
  onSelectionChange,
  onSend,
  speechEnabled = true,
  inputRef,
  inputRevision = 0,
  isInputRevisionCurrent,
  testIDPrefix = 'chat',
  reply,
  onCancelReply,
  attachments = [],
  attachmentsUploading = false,
  onRemoveAttachment,
}: Props) {
  const { theme } = useUnistyles();
  const multiline = height > COMPOSER_SINGLE_LINE_INPUT_HEIGHT;
  const containerRef = React.useRef<HTMLElement | null>(null);
  const commitInputChange = (nextValue: string) => {
    if (isInputRevisionCurrent?.(inputRevision) === false) return;
    onChangeText(nextValue);
  };

  // Speech recognition — internal hook, scoped to the composer.
  const speech = useSpeechInput((transcript) => {
    const separator = value && transcript ? ' ' : '';
    commitInputChange(value + separator + transcript);
  });
  const isListening = speech.state === 'listening';
  const isFinalizing = speech.state === 'finalizing';
  const isCapturingSpeech = isListening || isFinalizing;
  const speechAvailable = speech.capability === 'available' && speechEnabled !== false;
  const hasSomethingToSend = canSend ?? Boolean(value.trim());
  const hasLiveTranscript = Boolean(speech.partialText || value);
  const listeningWillSend = Boolean(value.trim() || speech.partialText.trim());
  const sendDisabled = disabled || !hasSomethingToSend || isCapturingSpeech;
  // The trailing control is mic XOR send, in one slot: while dictation is live
  // the control stays the listening/stop control even as partial transcript
  // fills the input; without speech, or once there is something to send, the
  // send control shows (disabled when nothing is sendable), so the corner is
  // never empty — including while an agent is working, when a tap queues the
  // next instruction.
  const showMic = speechAvailable && (isCapturingSpeech || !hasSomethingToSend);
  const showSend = !showMic;

  // The live words belong in the input itself. The status line only names the
  // microphone state, avoiding a second transcript underneath the composer.
  const statusLine: string =
    speech.state === 'permission-denied'
      ? 'microphone off in settings \u00b7 tap to open settings'
      : speech.state === 'nothing-recognised'
        ? "didn't catch that \u00b7 tap mic to try again"
        : speech.state === 'finalizing'
          ? 'finishing transcription'
          : speech.state === 'listening'
            ? listeningWillSend
              ? 'listening \u00b7 tap mic to send'
              : 'listening \u00b7 tap mic to stop'
            : '';
  const statusIsError =
    speech.state === 'permission-denied' || speech.state === 'nothing-recognised';

  React.useEffect(() => {
    if (!onDesktopPaste) return;
    const node = containerRef.current;
    if (!node) return;
    const listener = (event: Event) => onDesktopPaste(event as ClipboardEvent);
    node.addEventListener('paste', listener);
    return () => node.removeEventListener('paste', listener);
  }, [onDesktopPaste]);
  const visibleAttachments = attachments.slice(0, 3);
  const hiddenAttachmentCount = Math.max(0, attachments.length - visibleAttachments.length);
  return (
    <View
      ref={containerRef as React.Ref<View>}
      {...containerProps}
      style={[styles.composer, focused && styles.composerFocused]}
    >
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
        <View style={styles.inputWrapper}>
          <TextInput
            key={inputRevision}
            ref={inputRef}
            // A successful send replaces this native input to fence off stale
            // text events. If the consumed input was focused, transfer focus
            // to its empty replacement so consecutive messages need no tap.
            autoFocus={focused}
            style={[
              styles.input,
              Platform.OS === 'ios' ? undefined : { height, maxHeight },
              Platform.OS === 'android' && styles.inputAndroid,
              isCapturingSpeech && speech.partialText
                ? [
                    styles.inputTransparent,
                    Platform.OS === 'android' && styles.inputTransparentAndroid,
                  ]
                : undefined,
            ]}
            value={value}
            onChangeText={commitInputChange}
            onContentSizeChange={onContentSizeChange}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyPress={onKeyPress}
            onSelectionChange={onSelectionChange}
            placeholder={isCapturingSpeech ? (hasLiveTranscript ? '' : 'Listening') : 'Message'}
            placeholderTextColor={theme.buzz.dim}
            multiline
            // Android keyboards otherwise take the whole screen in landscape and
            // type into the OS extract editor instead of this composer. The prop
            // sets IME_FLAG_NO_FULLSCREEN; it is a no-op on the other platforms.
            disableFullscreenUI
            returnKeyType="default"
            scrollEnabled={height >= maxHeight}
            submitBehavior="newline"
            testID={`${testIDPrefix}-input`}
            accessibilityLabel="Message"
          />
          {isCapturingSpeech && speech.partialText ? (
            <View
              style={styles.interimOverlay}
              pointerEvents="none"
              testID={`${testIDPrefix}-speech-interim`}
            >
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.input,
                  styles.interimText,
                  Platform.OS === 'ios' ? undefined : { height: undefined, maxHeight: undefined },
                  Platform.OS === 'android' && styles.interimTextAndroid,
                ]}
              >
                <Text style={{ color: theme.buzz.textSecondary }}>
                  {value}
                  {value ? ' ' : ''}
                </Text>
                <Text style={[{ color: theme.buzz.textMuted }, styles.interimPartial]}>
                  {speech.partialText}
                </Text>
              </Text>
            </View>
          ) : null}
        </View>
        {showMic && speechAvailable ? (
          <TouchableOpacity
            accessibilityLabel={
              isFinalizing
                ? 'Finishing speech input'
                : isListening
                  ? listeningWillSend
                    ? 'Stop listening and send'
                    : 'Stop listening'
                  : speech.state === 'permission-denied'
                    ? 'Open microphone settings'
                    : 'Start speech input'
            }
            accessibilityRole="button"
            accessibilityHint={
              isFinalizing
                ? 'Waits for the final transcription before sending'
                : isListening
                  ? listeningWillSend
                    ? 'Stops dictation and sends'
                    : 'Stops dictation'
                  : 'Dictates into the message field'
            }
            accessibilityState={
              isFinalizing ? { selected: true, busy: true } : { selected: isListening }
            }
            accessibilityValue={
              isListening && speech.partialText
                ? { text: `Listening: ${speech.partialText}` }
                : undefined
            }
            hitSlop={9}
            onPress={() => {
              if (speech.state === 'permission-denied') {
                void Linking.openSettings();
                return;
              }
              if (isFinalizing) return;
              if (isListening) {
                const hadCommittedText = Boolean(value.trim());
                void speech.stop().then((captured) => {
                  if (captured !== null && (hadCommittedText || captured)) onSend?.();
                });
              } else {
                speech.start();
              }
            }}
            style={[
              styles.micButton,
              isListening && styles.micButtonListening,
              isListening && {
                opacity: 0.72 + speech.volumeLevel * 0.28,
                shadowOpacity: 0.16 + speech.volumeLevel * 0.44,
                shadowRadius: 4 + speech.volumeLevel * 6,
                transform: [{ scale: 1 + speech.volumeLevel * 0.12 }],
              },
              speech.state === 'permission-denied' && styles.micButtonDimmed,
            ]}
            testID={`${testIDPrefix}-mic`}
          >
            <MicGlyph
              animating={isListening}
              level={speech.volumeLevel}
              testID={`${testIDPrefix}-mic-glyph`}
              color={
                isListening
                  ? theme.buzz.accent
                  : speech.state === 'permission-denied'
                    ? theme.buzz.textMuted
                    : theme.buzz.textPrimary
              }
            />
          </TouchableOpacity>
        ) : null}
        {showSend ? (
          <Pressable
            accessibilityLabel="Send message"
            accessibilityRole="button"
            disabled={sendDisabled}
            hitSlop={9}
            // Never pass the responder event itself: the Room's handleSend
            // reads its first argument as a MessageShortcut, and a PressEvent
            // (truthy, no `.text`) made it skip the composer-clear block so
            // the field kept its text after every send.
            onPress={() => onSend?.()}
            style={styles.sendButton}
            testID={`${testIDPrefix}-send`}
          >
            <Text style={[styles.sendButtonText, sendDisabled && styles.sendButtonTextDisabled]}>
              ↑
            </Text>
          </Pressable>
        ) : null}
      </View>
      {statusLine ? (
        <TouchableOpacity
          accessibilityLabel={statusLine}
          accessibilityLiveRegion="polite"
          accessibilityRole={speech.state === 'permission-denied' ? 'button' : 'text'}
          activeOpacity={speech.state === 'permission-denied' ? 0.7 : 1}
          disabled={speech.state !== 'permission-denied'}
          onPress={
            speech.state === 'permission-denied' ? () => void Linking.openSettings() : undefined
          }
          style={styles.statusLine}
          testID={`${testIDPrefix}-speech-status`}
        >
          <Text
            style={[
              styles.statusText,
              statusIsError && styles.statusTextError,
              speech.state === 'listening' && styles.statusTextListening,
            ]}
          >
            {statusLine}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Speech recognition styles
  micButton: {
    width: 26,
    height: 26,
    // Same slot and size as the send control it swaps with, so the input's
    // width never jumps on the mic<->send exchange.
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonListening: {
    borderWidth: 1,
    borderColor: theme.buzz.accent,
    borderRadius: 13,
    shadowColor: theme.buzz.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  micButtonDimmed: {
    opacity: 0.4,
  },
  inputWrapper: {
    flex: 1,
    position: 'relative',
    minWidth: 0,
  },
  inputTransparent: {
    color: 'transparent',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  } as any,
  inputTransparentAndroid: {
    // Android can keep painting native composing glyphs through a transparent
    // text color. Hide that whole visual layer while the interim overlay owns
    // the words; the TextInput stays mounted and focused for the keyboard.
    opacity: 0,
  },
  interimOverlay: {
    justifyContent: 'flex-start',
    minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
    maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    pointerEvents: 'none',
  },
  interimText: {
    color: theme.buzz.textSecondary,
    ...Platform.select({ ios: {}, default: { lineHeight: 20 } }),
  },
  interimPartial: { fontStyle: 'italic' },
  interimTextAndroid: { textAlignVertical: 'center' },
  statusLine: {
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 6,
  },
  statusText: {
    ...(theme.buzz.type.machine as any),
    color: theme.buzz.ledgerQuiet,
    textTransform: 'uppercase',
  },
  statusTextError: {
    color: theme.buzz.dialogDanger,
  },
  statusTextListening: {
    color: theme.buzz.accent,
  },
  // End speech recognition styles
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
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButtonText: {
    ...theme.buzz.type.body,
    color: theme.buzz.textMuted,
  },
  input: {
    ...theme.buzz.type.body,
    // The wrapper owns the row's flexible width. Its children sit in Yoga's
    // default column axis, where flex growth would become a height constraint
    // and suppress iOS TextInput's intrinsic multiline growth. Android gets
    // its controlled height above; iOS remains intrinsic.
    minWidth: 0,
    ...Platform.select({ ios: {}, default: { lineHeight: 20 } }),
    color: theme.buzz.textSecondary,
    minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
    maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    paddingVertical: 0,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  // Keep Android's font bounds intact, then center its one-line layout in the
  // fixed field so the visible top and bottom space match.
  inputAndroid: { textAlignVertical: 'center' },
  sendButton: {
    width: 26,
    height: 26,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
  },
  sendButtonTextDisabled: { color: theme.buzz.textMuted },
}));
