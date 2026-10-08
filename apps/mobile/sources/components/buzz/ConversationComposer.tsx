import * as React from 'react';
import {
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
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
import { HullDialog } from './HullDialog';
import { MicGlyph } from './MicGlyph';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';
import { DictationWaveform } from './DictationWaveform';
import { useSpeechInput } from '@/buzz/speech-input';
import { removeComposerTag, removeLastComposerTag, splitComposerTags } from '@/buzz/composer-tags';

/**
 * A dictated message on its way out. ■ sets `cancelled` until the parent sets
 * `committed`, the moment the message enters the Room.
 */
export type DictatedSend = { cancelled: boolean; committed: boolean };

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
  /** A dictated send passes its ■ handle; the call may return the send's promise. */
  onSend(dictated?: DictatedSend): unknown;
  /**
   * Speech recognition is always available when the hook can use the native
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
  reply?: {
    handle: string;
    preview: string;
  };
  onCancelReply?(): void;
  /**
   * Room agent handles. A leading `@handle ` for one of them shows as a chip
   * instead of typed text; the text itself, and so the send, is unchanged.
   */
  tagHandles?: ReadonlySet<string>;
  /** Opens the tag menu from a chip, or from the empty chip while dictating. */
  onEditTags?(): void;
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
  speechHints,
  inputRef,
  inputRevision = 0,
  isInputRevisionCurrent,
  testIDPrefix = 'chat',
  reply,
  onCancelReply,
  tagHandles = NO_TAG_HANDLES,
  onEditTags,
  attachments = [],
  attachmentsUploading = false,
  onRemoveAttachment,
  onRetryAttachment,
}: Props) {
  const { theme } = useUnistyles();
  const multiline = height > COMPOSER_SINGLE_LINE_INPUT_HEIGHT;
  const containerRef = React.useRef<HTMLElement | null>(null);
  const commitInputChange = (nextValue: string) => {
    if (isInputRevisionCurrent?.(inputRevision) === false) return;
    onChangeText(nextValue);
  };

  // Leading agent tags show as chips; the input holds only the typed rest.
  // Every edit is written back with the chips' text in front of it.
  const tagSplit = splitComposerTags(value, tagHandles);
  const restSelectionRef = React.useRef({ start: 0, end: 0 });
  const commitRestChange = (nextRest: string) => commitInputChange(tagSplit.prefix + nextRest);

  // Speech recognition — internal hook, scoped to the composer.
  // What the current take added to the text, so ■ can take exactly that out.
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
  const messageOnItsWay = sendingTake !== null && !isCapturingSpeech;
  const speechAvailable = speech.capability === 'available' && speechEnabled !== false;
  // Chips alone are not a message: the field reads as empty and keeps the mic.
  const hasSomethingToSend = canSend ?? Boolean(tagSplit.rest.trim());
  const listeningWillSend = Boolean(tagSplit.rest.trim() || speech.partialText.trim());
  const sendDisabled = disabled || !hasSomethingToSend || isCapturingSpeech;
  // The trailing control is mic XOR send, in one slot: while dictation is live
  // the control stays the listening/stop control; without speech, or once
  // there is something to send, the send control shows (disabled when nothing
  // is sendable), so the corner is never empty — including while an agent is
  // working, when a tap queues the next instruction.
  const showMic = speechAvailable && (dictationBusy || !hasSomethingToSend);
  const showSend = !showMic;

  // Dictation shows a waveform, never live words. Only a failure that needs
  // the person to act has a line under the composer.
  const statusLine: string =
    speech.state === 'permission-denied'
      ? 'microphone off in settings \u00b7 tap to open settings'
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
    // Chips, typed text and the reply stay; only the take's words go.
    commitInputChange(
      added.reduceRight((text, part) => {
        const at = text.lastIndexOf(part);
        return at < 0 ? text : text.slice(0, at) + text.slice(at + part.length);
      }, value),
    );
  };
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
                <TouchableOpacity
                  accessibilityLabel={`Retry uploading ${attachment.name}`}
                  accessibilityRole="button"
                  disabled={attachmentsUploading}
                  onPress={() => onRetryAttachment?.(index)}
                  style={styles.retryButton}
                  testID={`pending-chat-attachment-retry-${index}`}
                >
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              )}
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
        {dictationBusy ? (
          <TouchableOpacity
            accessibilityLabel="Discard recording"
            accessibilityRole="button"
            hitSlop={9}
            onPress={discardTake}
            style={styles.attachButton}
            testID={`${testIDPrefix}-speech-discard`}
          >
            <View style={styles.discardGlyph} />
          </TouchableOpacity>
        ) : (
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
        )}
        {tagSplit.tags.length > 0 || (isCapturingSpeech && onEditTags) ? (
          // Chips scroll sideways inside a capped strip, so any number of tags
          // leaves the field and the mic their room.
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            style={styles.tagStrip}
            contentContainerStyle={styles.tagStripContent}
            testID={`${testIDPrefix}-tags`}
          >
            {/* The handle and × targets are siblings in the strip, so the ×
            target can overlap the pill and the gap on Android, where a target
            never reaches outside its parent. */}
            {tagSplit.tags.map((handle, index) => (
              <React.Fragment key={`${handle}:${index}`}>
                <TouchableOpacity
                  accessibilityLabel={`Edit tags, @${handle}`}
                  accessibilityRole="button"
                  // The message is already on its way; its tags are final.
                  disabled={!onEditTags || messageOnItsWay}
                  hitSlop={TAG_TARGET_SLOP}
                  onPress={onEditTags}
                  style={styles.tagChipBody}
                  testID={`${testIDPrefix}-tag-${handle}-edit`}
                >
                  <View
                    style={[styles.tagChipFace, styles.tagChipFaceStart]}
                    testID={`${testIDPrefix}-tag-${handle}`}
                  >
                    <Text numberOfLines={1} style={styles.tagChipText}>
                      @{handle}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityLabel={`Remove @${handle}`}
                  accessibilityRole="button"
                  disabled={messageOnItsWay}
                  hitSlop={TAG_TARGET_SLOP}
                  onPress={() => commitInputChange(removeComposerTag(value, tagHandles, handle))}
                  style={styles.tagChipRemove}
                  testID={`${testIDPrefix}-tag-${handle}-remove`}
                >
                  <View style={[styles.tagChipFace, styles.tagChipFaceEnd]}>
                    <Text style={styles.tagChipRemoveText}>×</Text>
                  </View>
                </TouchableOpacity>
              </React.Fragment>
            ))}
            {isCapturingSpeech && tagSplit.tags.length === 0 && onEditTags ? (
              <TouchableOpacity
                accessibilityLabel="Tag an agent"
                accessibilityRole="button"
                hitSlop={TAG_TARGET_SLOP}
                onPress={onEditTags}
                style={styles.tagChipEmpty}
                testID={`${testIDPrefix}-tag-empty`}
              >
                <View style={styles.tagChipEmptyFace}>
                  <Text style={styles.tagChipEmptyText}>@</Text>
                </View>
              </TouchableOpacity>
            ) : null}
          </ScrollView>
        ) : null}
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
              // The input stays mounted, and focused for the keyboard, under
              // the waveform; its typed text returns when dictation ends.
              dictationBusy ? styles.inputHidden : undefined,
            ]}
            value={tagSplit.rest}
            onChangeText={commitRestChange}
            onContentSizeChange={onContentSizeChange}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyPress={
              tagSplit.tags.length === 0
                ? onKeyPress
                : (event) => {
                    // One backspace at the start of the field removes the last chip.
                    const selection = restSelectionRef.current;
                    if (
                      event.nativeEvent.key === 'Backspace' &&
                      (!tagSplit.rest || (selection.start === 0 && selection.end === 0))
                    ) {
                      event.preventDefault();
                      commitInputChange(removeLastComposerTag(value, tagHandles));
                      return;
                    }
                    onKeyPress(event);
                  }
            }
            onSelectionChange={(event) => {
              const selection = event.nativeEvent.selection;
              restSelectionRef.current = selection;
              // The parent reads offsets into the whole text, chips included.
              const offset = tagSplit.prefix.length;
              onSelectionChange?.({
                ...event,
                nativeEvent: {
                  ...event.nativeEvent,
                  selection: { start: selection.start + offset, end: selection.end + offset },
                },
              });
            }}
            placeholder="Message"
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
              <DictationWaveform
                level={speech.volumeLevel}
                live={isListening}
                testID={`${testIDPrefix}-speech-waveform`}
              />
            </View>
          ) : null}
        </View>
        {showMic && speechAvailable ? (
          <TouchableOpacity
            accessibilityLabel={
              isFinalizing || sendingTake
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
              isFinalizing || sendingTake
                ? 'Waits for the final transcription before sending'
                : isListening
                  ? listeningWillSend
                    ? 'Stops dictation and sends'
                    : 'Stops dictation'
                  : 'Dictates into the message field'
            }
            accessibilityState={
              isFinalizing || sendingTake
                ? { selected: true, busy: true }
                : { selected: isListening }
            }
            hitSlop={9}
            onPress={() => {
              if (speech.state === 'permission-denied') {
                void Linking.openSettings();
                return;
              }
              if (isFinalizing || sendingTake) return;
              if (isListening) {
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
              } else {
                takeTextRef.current = [];
                speech.start();
              }
            }}
            style={[
              styles.micButton,
              speech.state === 'permission-denied' && styles.micButtonDimmed,
            ]}
            testID={`${testIDPrefix}-mic`}
          >
            {isFinalizing || sendingTake ? (
              <BeelineMarkSpinner live testID={`${testIDPrefix}-speech-finalizing`} />
            ) : (
              <MicGlyph color={theme.buzz.textPrimary} testID={`${testIDPrefix}-mic-glyph`} />
            )}
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
          <Text style={[styles.statusText, styles.statusTextError]}>{statusLine}</Text>
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
  );
}

const MIC_SIZE = 26;
// Like ＋ and the mic: a 26-tall target reaches 44 with 9 above and below.
const TAG_TARGET_SLOP = { top: 9, bottom: 9 };

const styles = StyleSheet.create((theme) => ({
  // Speech recognition styles
  micButton: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    // Same slot and size as the send control it swaps with, so the input's
    // width never jumps on the mic<->send exchange.
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
  waveformOverlay: { minHeight: COMPOSER_SINGLE_LINE_INPUT_HEIGHT, justifyContent: 'center' },
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
  statusTextError: {
    color: theme.buzz.dialogDanger,
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
  attachmentFailed: { color: theme.buzz.danger },
  retryButton: {
    minHeight: 44,
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  retryButtonText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
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
  discardGlyph: {
    width: 10,
    height: 10,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.textPrimary,
  },
  // The strip spans the row's full height, so the chip targets' slop fits in it.
  tagStrip: {
    flexGrow: 0,
    flexShrink: 1,
    maxWidth: '50%',
    marginVertical: -8,
  },
  tagStripContent: { alignItems: 'center' },
  // The v6 pill, drawn in two halves: the handle half in the handle target,
  // the × half in the middle of the 44-wide × target.
  tagChipFace: {
    height: 22,
    justifyContent: 'center',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgHighlight,
  },
  tagChipFaceStart: {
    paddingLeft: theme.buzz.space.sm,
    borderLeftWidth: 1,
    borderTopLeftRadius: theme.buzz.radius,
    borderBottomLeftRadius: theme.buzz.radius,
  },
  tagChipFaceEnd: {
    borderRightWidth: 1,
    borderTopRightRadius: theme.buzz.radius,
    borderBottomRightRadius: theme.buzz.radius,
  },
  tagChipBody: { height: 26, justifyContent: 'center' },
  tagChipText: { ...theme.buzz.type.machine, color: theme.buzz.accent },
  // 16 + the 20 px × + 8 = 44: the target reaches 16 back over the handle
  // and 8 past the pill, 4 of them over the next pill's padding, which keeps
  // the v6 4 px gap. Drawn above its neighbours so the × always wins.
  tagChipRemove: {
    width: 44,
    height: 26,
    justifyContent: 'center',
    paddingLeft: theme.buzz.space.md,
    paddingRight: theme.buzz.space.sm,
    marginLeft: -theme.buzz.space.md,
    marginRight: -theme.buzz.space.xs,
    zIndex: 1,
  },
  tagChipRemoveText: {
    ...theme.buzz.type.meta,
    width: 20,
    textAlign: 'center',
    color: theme.buzz.ledgerQuiet,
  },
  tagChipEmpty: {
    height: 26,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagChipEmptyFace: {
    height: 22,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
  },
  tagChipEmptyText: { ...theme.buzz.type.machine, color: theme.buzz.textMuted },
  input: {
    ...theme.buzz.type.body,
    // The wrapper owns the row's flexible width. Its children sit in Yoga's
    // default column axis, where flex growth would become a height constraint
    // and suppress iOS TextInput's intrinsic multiline growth. Android gets
    // its controlled height above; iOS remains intrinsic.
    minWidth: 0,
    // Not the body role's lineHeight: kept below Space Grotesk's real glyph
    // bounds at this size on Android/web so centering never removes native
    // font padding in a way that could crop accents or descenders
    // (`chat.composer-layout.test.ts`).
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
