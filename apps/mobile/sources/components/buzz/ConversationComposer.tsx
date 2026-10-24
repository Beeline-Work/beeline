import { Button } from '@/components/buzz/Button';
import * as React from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Keyboard,
  Linking,
  Platform,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
  type TextLayoutEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { groknight } from '@/buzz/groknight';
import { HullDialog } from './HullDialog';
import { ArrowUpGlyph, COMPOSER_GLYPH_SIZE, MicGlyph, PlusGlyph, StopGlyph, WaveformGlyph } from './MicGlyph';
import { VoiceAgentStrip, VoiceBar } from './VoiceBar';
import { RuntimeErrorBoundary } from './RuntimeErrorBoundary';
import type { VoiceCallState } from '@/buzz/use-voice-call';
import { VOICE_LONG_PRESS_MS } from '@beeline/api-contract/phone';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { DictationWaveform } from './DictationWaveform';
import { useSpeechInput } from '@/buzz/speech-input';
import { composerBackspaceCursor, deleteComposerTagBackward, splitComposerTags } from '@/buzz/composer-tags';

/**
 * A dictated message on its way out. Stop sets `cancelled` until the parent sets
 * `committed`, the moment the message enters the Room.
 */
export type DictatedSend = { cancelled: boolean; committed: boolean };

type Props = {
  voice?: VoiceCallState;
  value: string;
  /** Whether the server member roster contains an agent. */
  hasAgentMembers?: boolean;
  isDirectMessage?: boolean;
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
  /** A dictated send passes its Stop handle; the call may return the send's promise. */
  onSend(dictated?: DictatedSend): unknown;
  /**
   * Speech recognition is available when the hook can use the browser or native
   * platform recogniser. Pass `false` to disable it (e.g. when the parent
   * environment already tested availability).
   */
  speechEnabled?: boolean;
  /** Names spoken in this conversation, so dictation spells them as written. */
  speechHints?: readonly string[];
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
  /** One-line viewer pill: the same controls and speech state with centered type. */
  viewerPill?: boolean;
  reply?: {
    handle: string;
    preview: string;
  };
  onCancelReply?(): void;
  /**
   * Room member handles. One backspace right after an `@handle` for one of
   * them deletes the whole tag.
   */
  tagHandles?: ReadonlySet<string>;
  attachments?: readonly {
    uri: string;
    name: string;
    mimeType: string;
    sizeLabel: string;
    /** Background upload state; undefined before the upload starts reads as uploading. */
    uploadState?: 'uploading' | 'uploaded' | 'failed';
  }[];
  attachmentsUploading?: boolean;
  onRemoveAttachment?(index: number): void;
  onRetryAttachment?(index: number): void;
};

export const COMPOSER_SINGLE_LINE_INPUT_HEIGHT = 26;
export const COMPOSER_MAX_INPUT_HEIGHT = 5 * groknight.type.body.lineHeight;
const NO_TAG_HANDLES: ReadonlySet<string> = new Set();

export function ConversationComposer(props: Props) {
  return <RuntimeErrorBoundary scope="conversation" onError={() => props.voice?.end()}
    onRetry={() => props.voice?.join()}>
    <ConversationComposerContent {...props} />
  </RuntimeErrorBoundary>;
}

/** The one text-entry row used by both desktop Room and embedded Corner conversations. */
function ConversationComposerContent({
  voice,
  hasAgentMembers = false,
  isDirectMessage = false,
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
  speechHints,
  inputRef,
  inputRevision = 0,
  isInputRevisionCurrent,
  testIDPrefix = 'chat',
  viewerPill = false,
  reply,
  onCancelReply,
  tagHandles = NO_TAG_HANDLES,
  attachments = [],
  attachmentsUploading = false,
  onRemoveAttachment,
  onRetryAttachment,
}: Props) {
  const { theme } = useUnistyles();
  const voiceHeld = React.useRef(false);
  const containerRef = React.useRef<HTMLElement | null>(null);
  const ownInputRef = React.useRef<TextInput | null>(null);
  const [textOffset, setTextOffset] = React.useState(0);
  const [nativeLineHeight, setNativeLineHeight] = React.useState(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
  // A scaled single line is still one line. Bottom-align only a paragraph
  // taller than the measured line, so the viewer's spare space stays balanced.
  const multiline = height > Math.max(COMPOSER_SINGLE_LINE_INPUT_HEIGHT, Math.ceil(nativeLineHeight));
  // A caller can keep an empty field at 26dp (the viewer does). A scaled
  // natural line must still fit before Android can center its baseline.
  const inputHeight = Platform.OS === 'android' ? Math.max(height, Math.ceil(nativeLineHeight)) : height;
  // iOS top-aligns its intrinsic text. Its 26dp minimum leaves extra space
  // only for a short single line; a grown paragraph has no such extra inset.
  const drawingOffset = textOffset + (Platform.OS === 'ios' && !multiline
    ? Math.max(0, COMPOSER_SINGLE_LINE_INPUT_HEIGHT - nativeLineHeight) / 2
    : 0);
  const measureTextBody = React.useCallback((event: TextLayoutEvent) => {
    const line = event.nativeEvent.lines[0];
    if (!line) return;
    // Center the cap-to-baseline body, rather than the font's asymmetric
    // ascent/descent box. Text and TextInput use the same natural metrics.
    // Moving the drawing does not change contentSize or inline span layout.
    // iOS reports the used glyph rect as `height`; ascent + descent describe
    // its full line fragment, including paragraph leading.
    const lineHeight = Platform.OS === 'ios' ? line.ascender + line.descender : line.height;
    const offset = lineHeight / 2 - line.ascender + line.capHeight / 2;
    if (Number.isFinite(offset)) {
      setTextOffset(offset);
      setNativeLineHeight(lineHeight);
    }
  }, []);
  const setInputRef = React.useCallback(
    (node: TextInput | null) => {
      ownInputRef.current = node;
      if (typeof inputRef === 'function') inputRef(node);
      else if (inputRef) (inputRef as React.MutableRefObject<TextInput | null>).current = node;
    },
    [inputRef],
  );
  const commitInputChange = (nextValue: string) => {
    if (isInputRevisionCurrent?.(inputRevision) === false) return;
    onChangeText(nextValue);
  };

  // Tags are plain text. Send and dictation still read the leading ones:
  // tags alone are not a message.
  const tagSplit = splitComposerTags(value, tagHandles);
  // The selection the input last reported, for a backspace after a tag.
  const selectionRef = React.useRef({ start: 0, end: 0 });
  // Where the cursor goes once the input holds the text without a deleted tag.
  const pendingCursorRef = React.useRef<number | null>(null);
  /** Deletes the whole tag that ends at `cursor`, if one does. */
  const deleteTagBackward = (cursor: number) => {
    const next = deleteComposerTagBackward(value, cursor, tagHandles);
    if (!next) return false;
    if (isInputRevisionCurrent?.(inputRevision) !== false) {
      pendingCursorRef.current = next.cursor;
      selectionRef.current = { start: next.cursor, end: next.cursor };
    }
    commitInputChange(next.text);
    return true;
  };
  const commitNativeChange = (nextText: string) => {
    // Android keyboards often send no Backspace key event, so a one-character
    // deletion at the end of a tag is read from the text instead.
    const cursor = composerBackspaceCursor(value, nextText, selectionRef.current);
    if (cursor !== null && deleteTagBackward(cursor)) return;
    commitInputChange(nextText);
  };
  React.useLayoutEffect(() => {
    const cursor = pendingCursorRef.current;
    if (cursor === null) return;
    pendingCursorRef.current = null;
    const input = ownInputRef.current as unknown as {
      setSelection?(start: number, end: number): void;
      setSelectionRange?(start: number, end: number): void;
    } | null;
    if (Platform.OS === 'web') input?.setSelectionRange?.(cursor, cursor);
    else input?.setSelection?.(cursor, cursor);
  }, [value]);

  React.useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const input = ownInputRef.current as unknown as HTMLTextAreaElement | null;
    if (!input || typeof input.getBoundingClientRect !== 'function') return;
    let active = true;
    const measure = () => {
      if (!active || typeof CanvasRenderingContext2D === 'undefined') return;
      const css = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      const metrics = context.measureText('M');
      const lineHeight = parseFloat(css.lineHeight);
      const inputHeight = Math.min(input.clientHeight, COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
      const offset = (inputHeight - lineHeight) / 2 +
        (metrics.actualBoundingBoxAscent - metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 2;
      if (Number.isFinite(offset)) setTextOffset(offset);
    };
    measure();
    // Re-measure after the actual face arrives, and after responsive resizing.
    void document.fonts?.ready.then(measure);
    document.fonts?.addEventListener('loadingdone', measure);
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(input);
    return () => {
      active = false;
      document.fonts?.removeEventListener('loadingdone', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [height, inputRevision, theme.buzz.type.body]);

  // Speech recognition — internal hook, scoped to the composer.
  // What the current take added to the text, so Stop can take exactly that out.
  const takeTextRef = React.useRef<string[]>([]);
  const speech = useSpeechInput((transcript) => {
    const separator = value && transcript && !/\s$/.test(value) ? ' ' : '';
    takeTextRef.current.push(separator + transcript);
    commitInputChange(value + separator + transcript);
  }, speechHints);
  const isListening = speech.state === 'listening';
  const isFinalizing = speech.state === 'finalizing';
  const isCapturingSpeech = isListening || isFinalizing;
  // A dictated message stays cancellable while it is sent, until it enters the Room.
  const [sendingTake, setSendingTake] = React.useState<DictatedSend | null>(null);
  // The parent replaces the input once it has taken the message into the Room.
  React.useEffect(() => setSendingTake(null), [inputRevision]);
  const dictationBusy = isCapturingSpeech || sendingTake !== null;
  const speechAvailable = speech.capability === 'available' && speechEnabled !== false;
  // Tags alone are not a message: the field reads as empty and keeps the mic.
  const hasSomethingToSend = canSend ?? Boolean(tagSplit.rest.trim());
  const sendingSpeech = isFinalizing || sendingTake !== null;
  // Fixed places: ＋ on the left; the voice spot holds the mic, or Stop while
  // a take is live; the far right is the go action — Conversation while there
  // is nothing to send, Send otherwise. While dictating, Send posts the take.
  // Without Conversation the far right is always Send, disabled when empty,
  // so it still never moves — including while an agent is working, when a
  // tap queues the next instruction.
  const showConversation = Boolean(voice) && (voice?.connecting || (!hasSomethingToSend && !dictationBusy));
  const sendDisabled = disabled || sendingSpeech || (!hasSomethingToSend && !isListening);
  const dailyLimitError = voice?.error?.startsWith('Calls resume at ') ? voice.error : null;
  const conversationActive = Boolean(!voice?.connecting && (voice?.call || (voice?.error && !dailyLimitError)));
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !showConversation || conversationActive) return;
    containerRef.current?.querySelector(`[data-testid="${testIDPrefix}-conversation"]`)
      ?.setAttribute('title', 'Conversation mode');
  }, [showConversation, conversationActive, testIDPrefix]);

  // Dictation shows a waveform, never live words. Only a failure that needs
  // the person to act has a line under the composer.
  const statusLine: string =
    speech.state === 'permission-denied'
      ? Platform.OS === 'web'
        ? 'allow microphone in browser site settings \u00b7 tap mic to try again'
        : 'microphone off in settings \u00b7 tap to open settings'
      : speech.state === 'nothing-recognised'
        ? "didn't catch that \u00b7 tap mic to try again"
        : '';

  React.useEffect(() => {
    if (!onDesktopPaste) return;
    const node = containerRef.current;
    if (!node) return;
    const listener = (event: Event) => onDesktopPaste(event as ClipboardEvent);
    node.addEventListener('paste', listener);
    return () => node.removeEventListener('paste', listener);
  }, [onDesktopPaste]);
  const discardTake = () => {
    if (sendingTake?.committed) return;
    if (sendingTake) sendingTake.cancelled = true;
    if (isCapturingSpeech) speech.cancel();
    setSendingTake(null);
    const added = takeTextRef.current;
    takeTextRef.current = [];
    if (added.length === 0) return;
    // Tags, typed text and the reply stay; only the take's words go.
    commitInputChange(
      added.reduceRight((text, part) => {
        const at = text.lastIndexOf(part);
        return at < 0 ? text : text.slice(0, at) + text.slice(at + part.length);
      }, value),
    );
  };
  // Send while dictating: stop, wait for the final words, then send them with
  // any typed text and staged files.
  const sendTake = () => {
    const hadTypedText = Boolean(tagSplit.rest.trim());
    // Held from the press, so the field stays a waveform from the
    // transcription through the send.
    const send: DictatedSend = { cancelled: false, committed: false };
    const settle = () =>
      setSendingTake((current) => (current === send ? null : current));
    setSendingTake(send);
    void speech.stop().then((captured) => {
      if (send.cancelled || captured === null || !(hadTypedText || captured)) {
        settle();
        return;
      }
      void Promise.resolve(onSend(send)).finally(settle);
    });
  };
  const visibleAttachments = attachments.slice(0, 3);
  const hiddenAttachmentCount = Math.max(0, attachments.length - visibleAttachments.length);
  return (
    <>
    {(conversationActive || voice?.connecting) && voice && <VoiceAgentStrip voice={voice} />}
    <View
      ref={containerRef as React.Ref<View>}
      {...containerProps}
      style={[styles.composer, focused && styles.composerFocused,
        ...(viewerPill ? [styles.viewerPill] : [])]}
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
              <Button
                  accessibilityLabel="Cancel reply"
                accessibilityRole="button"
                onPress={onCancelReply}
                  testID="reply-composer-cancel"
                  label="" icon={<Text style={styles.removeButtonText}>{"×"}</Text>}
                  variant="quiet"
                  iconOnly
                />
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
                <Text
                  numberOfLines={1}
                  style={styles.attachmentMeta}
                  testID={`pending-chat-attachment-meta-${index}`}
                >
                  <Text
                    style={attachment.uploadState === 'failed' && styles.attachmentFailed}
                    testID={`pending-chat-attachment-state-${index}`}
                  >
                    {attachment.uploadState === 'uploaded'
                      ? 'Ready'
                      : attachment.uploadState === 'failed'
                        ? 'Upload failed'
                        : 'Uploading…'}
                  </Text>{' '}
                  · {attachment.sizeLabel} · {attachment.mimeType.toUpperCase()}
                </Text>
              </View>
              {attachment.uploadState === 'failed' && (
                <Button
                  label="Retry"
                  variant="secondary"
                  accessibilityLabel={`Retry uploading ${attachment.name}`}
                  disabled={attachmentsUploading}
                  onPress={() => onRetryAttachment?.(index)}
                  testID={`pending-chat-attachment-retry-${index}`}
                />
              )}
              <Button
                  accessibilityLabel={`Remove ${attachment.name}`}
                accessibilityRole="button"
                disabled={attachmentsUploading}
                onPress={() => onRemoveAttachment?.(index)}
                  testID={`pending-chat-attachment-remove-${index}`}
                  label="" icon={<Text style={styles.removeButtonText}>{"×"}</Text>}
                  variant="quiet"
                  iconOnly
                />
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
      {conversationActive && voice ? (
        <VoiceBar voice={voice} testIDPrefix={testIDPrefix} />
      ) : (
        <View
        style={[styles.inputRow, viewerPill && styles.viewerPillRow, multiline && styles.composerMultiline]}
        testID={`${testIDPrefix}-composer-input-row`}
      >
        {/* Room attachments remain available while dictating. */}
        {!viewerPill && (
        <TouchableOpacity
          accessibilityLabel="Attach photo or document"
          accessibilityRole="button"
          disabled={attachDisabled || !onAttach}
          hitSlop={9}
          onPress={onAttach}
          style={styles.attachButton}
          testID={`${testIDPrefix}-attach-button`}
        >
          <PlusGlyph
            color={attachDisabled || !onAttach ? theme.buzz.textMuted : theme.buzz.textPrimary}
            testID={`${testIDPrefix}-attach-glyph`}
          />
        </TouchableOpacity>
        )}
        <View style={styles.inputWrapper}>
          {Platform.OS !== 'web' ? (
            <Text
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              numberOfLines={1}
              onTextLayout={measureTextBody}
              style={[styles.textMeasurement, Platform.OS === 'android' && styles.inputAndroid]}
              testID={`${testIDPrefix}-text-measurement`}
            >
              Message
            </Text>
          ) : null}
          <TextInput
            key={inputRevision}
            ref={setInputRef}
            // A successful send replaces this native input to fence off stale
            // text events. If the consumed input was focused, transfer focus
            // to its empty replacement so consecutive messages need no tap.
            autoFocus={focused}
            style={[
              styles.input,
              Platform.OS === 'ios' ? undefined : { height: inputHeight, maxHeight },
              Platform.OS === 'android' && styles.inputAndroid,
              { transform: [{ translateY: drawingOffset }] },
              // The input stays mounted under the waveform; its typed text
              // returns when dictation ends.
              dictationBusy ? styles.inputHidden : undefined,
            ]}
            value={value}
            onChangeText={Platform.OS === 'web' ? commitInputChange : commitNativeChange}
            onContentSizeChange={onContentSizeChange}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyPress={(event) => {
              // The web gets every Backspace as a key event, before the
              // browser deletes anything; a word or line delete keeps its own.
              const key = event.nativeEvent as TextInputKeyPressEventData & {
                altKey?: boolean;
                ctrlKey?: boolean;
                metaKey?: boolean;
              };
              if (
                Platform.OS === 'web' &&
                key.key === 'Backspace' &&
                !key.altKey &&
                !key.ctrlKey &&
                !key.metaKey
              ) {
                const node = (event as unknown as { target?: HTMLTextAreaElement }).target;
                const selection =
                  typeof node?.selectionStart === 'number'
                    ? { start: node.selectionStart, end: node.selectionEnd }
                    : selectionRef.current;
                if (selection.start === selection.end && deleteTagBackward(selection.start)) {
                  event.preventDefault();
                  return;
                }
              }
              onKeyPress(event);
            }}
            onSelectionChange={(event) => {
              selectionRef.current = event.nativeEvent.selection;
              onSelectionChange?.(event);
            }}
            placeholder={!isDirectMessage && hasAgentMembers ? 'Tag an agent with @' : 'Message'}
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
          {dictationBusy ? (
            <View style={styles.waveformOverlay}>
              {/* The leading tags stay in view, as text, while the take is recorded. */}
              {tagSplit.tags.length > 0 ? (
                <Text numberOfLines={1} style={styles.dictationTags} testID={`${testIDPrefix}-dictation-tags`}>
                  {tagSplit.prefix.trimEnd()}
                </Text>
              ) : null}
              <DictationWaveform
                level={speech.volumeLevel}
                live={isListening}
                testID={`${testIDPrefix}-speech-waveform`}
              />
            </View>
          ) : null}
        </View>
        {speechAvailable && dictationBusy ? (
          // Keyed apart from the mic, so a press in flight on one never lands on the other.
          <TouchableOpacity
            key="stop"
            accessibilityLabel="Stop recording"
            accessibilityHint="Discards this take; typed text stays"
            accessibilityRole="button"
            disabled={sendingTake?.committed}
            hitSlop={9}
            onPress={discardTake}
            style={styles.controlSlot}
            testID={`${testIDPrefix}-speech-discard`}
          >
            <StopGlyph color={theme.buzz.textPrimary} testID={`${testIDPrefix}-stop-glyph`} />
          </TouchableOpacity>
        ) : speechAvailable ? (
          <TouchableOpacity
            key="mic"
            accessibilityLabel={
              speech.state === 'permission-denied' && Platform.OS !== 'web'
                ? 'Open microphone settings'
                : 'Start speech input'
            }
            accessibilityRole="button"
            accessibilityHint="Dictates into the message field"
            hitSlop={9}
            delayLongPress={VOICE_LONG_PRESS_MS}
            onPressIn={() => { voiceHeld.current = false; }}
            onLongPress={voice && !disabled ? () => {
              voiceHeld.current = true;
              Keyboard.dismiss();
              void voice.join();
            } : undefined}
            onPress={() => {
              if (voiceHeld.current) return;
              if (speech.state === 'permission-denied' && Platform.OS !== 'web') {
                void Linking.openSettings();
                return;
              }
              takeTextRef.current = [];
              // A take needs no keyboard; lowering it shows the whole Room.
              Keyboard.dismiss();
              speech.start();
            }}
            style={[
              styles.controlSlot,
              speech.state === 'permission-denied' && styles.micButtonDimmed,
            ]}
            testID={`${testIDPrefix}-mic`}
          >
            <MicGlyph
              color={theme.buzz.textPrimary}
              size={COMPOSER_GLYPH_SIZE}
              testID={`${testIDPrefix}-mic-glyph`}
            />
          </TouchableOpacity>
        ) : null}
        {showConversation ? (
          <TouchableOpacity
            accessibilityLabel={voice?.connecting ? 'Connecting conversation mode' : 'Conversation mode'}
            accessibilityRole="button"
            disabled={disabled || voice?.connecting}
            accessibilityState={{ disabled: disabled || voice?.connecting, busy: voice?.connecting }}
            aria-busy={Boolean(voice?.connecting)}
            hitSlop={9}
            onPress={() => {
              Keyboard.dismiss();
              void voice?.join();
            }}
            style={styles.controlSlot}
            testID={`${testIDPrefix}-conversation`}
          >
            {voice?.connecting ? <SurfaceGlyphLoader compact size={COMPOSER_GLYPH_SIZE} testID="voice-startup-loader" />
              : <WaveformGlyph color={disabled ? theme.buzz.textMuted : theme.buzz.textPrimary} />}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            accessibilityLabel={sendingSpeech ? 'Finishing speech input' : 'Send message'}
            accessibilityHint={
              sendingSpeech
                ? 'Waits for the final transcription before sending'
                : isListening
                  ? 'Stops dictation and sends'
                  : undefined
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: sendDisabled, busy: sendingSpeech }}
            disabled={sendDisabled}
            hitSlop={9}
            // Never pass the responder event itself: the Room's handleSend
            // reads its first argument as a MessageShortcut, and a PressEvent
            // (truthy, no `.text`) made it skip the composer-clear block so
            // the field kept its text after every send.
            onPress={() => (isListening ? sendTake() : onSend?.())}
            style={styles.controlSlot}
            testID={`${testIDPrefix}-send`}
          >
            {sendingSpeech ? (
              <BeelineMarkSpinner
                ink={theme.buzz.accent}
                live
                testID={`${testIDPrefix}-speech-finalizing`}
              />
            ) : (
              <ArrowUpGlyph
                color={sendDisabled ? theme.buzz.textMuted : theme.buzz.accent}
                testID={`${testIDPrefix}-send-glyph`}
              />
            )}
          </TouchableOpacity>
        )}
      </View>
      )}
      {dailyLimitError && <View style={styles.statusLine}>
        <Text style={styles.statusText} accessibilityRole="alert" testID="voice-connection-error">{dailyLimitError}</Text>
      </View>}
      {statusLine ? (
        <TouchableOpacity
          accessibilityLabel={statusLine}
          accessibilityLiveRegion="polite"
          accessibilityRole={speech.state === 'permission-denied' && Platform.OS !== 'web' ? 'button' : 'text'}
          activeOpacity={speech.state === 'permission-denied' && Platform.OS !== 'web' ? 0.7 : 1}
          disabled={speech.state !== 'permission-denied' || Platform.OS === 'web'}
          onPress={
            speech.state === 'permission-denied' && Platform.OS !== 'web' ? () => void Linking.openSettings() : undefined
          }
          style={styles.statusLine}
          testID={`${testIDPrefix}-speech-status`}
        >
          <Text style={styles.statusText}>{statusLine}</Text>
        </TouchableOpacity>
      ) : null}
      <HullDialog
        visible={speech.modelDownloadOffered}
        title="Download the voice model?"
        body="Android punctuates dictation with its on-device voice model, which is not on this phone yet. Android may ask to confirm the download."
        onRequestClose={() => void speech.declineModelDownload()}
        actions={[
          {
            label: 'Not now',
            onPress: () => void speech.declineModelDownload(),
            testID: `${testIDPrefix}-speech-model-decline`,
          },
          {
            label: 'Download',
            variant: 'primary',
            onPress: speech.acceptModelDownload,
            testID: `${testIDPrefix}-speech-model-download`,
          },
        ]}
        testID={`${testIDPrefix}-speech-model-dialog`}
      />
    </View>
    </>
  );
}

const CONTROL_SIZE = 26;

const styles = StyleSheet.create((theme) => ({
  // The voice spot and the go action: one 26pt slot each, reached by a 44pt
  // target, so no swap ever moves a control or the input's width.
  controlSlot: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonDimmed: {
    opacity: 0.4,
  },
  inputWrapper: {
    flex: 1,
    position: 'relative',
    minWidth: 0,
  },
  inputHidden: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
  },
  waveformOverlay: {
    minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusLine: {
    paddingHorizontal: theme.buzz.space.md,
    paddingTop: theme.buzz.space.xs,
    paddingBottom: theme.buzz.space.sm,
  },
  statusText: {
    ...(theme.buzz.type.machine as any),
    color: theme.buzz.ledgerQuiet,
    textTransform: 'uppercase',
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
    paddingHorizontal: theme.buzz.space.sm,
  },
  composerMultiline: { alignItems: 'flex-end' },
  composerFocused: {
    borderColor: theme.buzz.accent,
  },
  viewerPill: { borderWidth: 0, borderRadius: 0, backgroundColor: 'transparent' },
  // Without the Room's two border insets, the row itself fills the 44dp field.
  viewerPillRow: { minHeight: 44 },
  adjuncts: { borderBottomWidth: 1, borderBottomColor: theme.buzz.border },
  adjunctDivider: { borderTopWidth: 1, borderTopColor: theme.buzz.border },
  reply: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
  },
  replyCopy: { flex: 1, minWidth: 0, paddingVertical: theme.buzz.space.sm },
  replyLabel: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  replyGlyph: { color: theme.buzz.accent },
  replyHandle: { color: theme.buzz.accent },
  replyPreview: {
    ...theme.buzz.type.meta,
    marginTop: theme.buzz.space.xs,
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
  attachmentFailed: { color: theme.buzz.textPrimary },
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
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dictationTags: {
    ...theme.buzz.type.body,
    ...Platform.select({ android: { lineHeight: undefined }, default: {} }),
    flexShrink: 1,
    marginRight: theme.buzz.space.xs,
    color: theme.buzz.textSecondary,
  } as any,
  input: {
    ...theme.buzz.type.body,
    // The wrapper owns the row's flexible width. Its children sit in Yoga's
    // default column axis, where flex growth would become a height constraint
    // and suppress iOS TextInput's intrinsic multiline growth. Android gets
    // its controlled height above; iOS remains intrinsic.
    minWidth: 0,
    // Not the body role's lineHeight: kept below Space Grotesk's real glyph
    // bounds at this size on web so centering never removes native font
    // padding in a way that could crop accents or descenders
    // (`chat.composer-layout.test.ts`). Android unsets the body role's line
    // height: React Native marks each styled span with its own line height,
    // and an inline tag starts the text span mid-line. Android's partial
    // relayout then drops the tag's line from the measured height on
    // alternate keystrokes, so the transcript above the composer jitters.
    ...Platform.select({
      ios: {},
      android: { lineHeight: undefined },
      default: { lineHeight: 20 },
    }),
    color: theme.buzz.textSecondary,
    minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
    maxHeight: COMPOSER_MAX_INPUT_HEIGHT,
    paddingVertical: 0,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  textMeasurement: {
    ...theme.buzz.type.body,
    ...Platform.select({ android: { lineHeight: undefined }, default: {} }),
    position: 'absolute',
    opacity: 0,
  },
  // Keep lineHeight unset so leading tags cannot jitter the measurement.
  // The measured drawing offset above balances the actual cap-height body.
  inputAndroid: {
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
}));
