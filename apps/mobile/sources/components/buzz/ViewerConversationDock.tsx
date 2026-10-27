import { appErrorCopy } from '@/buzz/app-error-copy';
import { Button } from './Button';
import React from 'react';
import { Animated, Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { currentViewerConversation, subscribeViewerConversation, viewerAgentHandle, viewerContext, viewerContextLabel } from '@/buzz/viewer-conversation';
import { withAlpha } from '@/buzz/groknight';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { COMPOSER_SINGLE_LINE_INPUT_HEIGHT, ConversationComposer, type DictatedSend } from '@/components/buzz/ConversationComposer';
import { TranscriptReference } from './TranscriptReference';
import { ConversationGlyph } from './MicGlyph';
import { MonoMarkdown } from './MonoMarkdown';

type Entry = { id: string; speaker: string; text: string; context?: string };

/** Small conversation controls that float above a full-height viewer. */
export function ViewerConversationDock({
  kind, title, roomId, agentHandle, artifact, captureScreen, keyboardAvoidedByParent = false,
}: {
  kind: 'artifact' | 'computer';
  title: string;
  roomId?: string;
  agentHandle?: string;
  artifact?: AttachmentReference;
  captureScreen?: () => Promise<string | null>;
  /** HullModal already moves its content above the keyboard; warm viewers do not. */
  keyboardAvoidedByParent?: boolean;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const transcriptScroll = React.useRef<ScrollView>(null);
  const scrollToNewest = () => {
    const scroll = () => transcriptScroll.current?.scrollToEnd({ animated: false });
    // Native layout commits after the content-size callback; web layout is already available.
    if (Platform.OS === 'web') scroll();
    else requestAnimationFrame(scroll);
  };
  const conversation = React.useSyncExternalStore(
    subscribeViewerConversation,
    () => currentViewerConversation(roomId),
    () => currentViewerConversation(roomId),
  );
  const initialIds = React.useRef(new Set(conversation?.messages.map((message) => message.id) ?? []));
  const initialTranscriptSeen = React.useRef(Boolean(conversation));
  const receivedIds = React.useRef(new Set<string>());
  const sentToAgent = React.useRef(false);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [draft, setDraft] = React.useState('');
  const draftRef = React.useRef('');
  const [height, setHeight] = React.useState(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
  const [revision, setRevision] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [pillHeight, setPillHeight] = React.useState(44);
  const [tickerVisible, setTickerVisible] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [availableWidth, setAvailableWidth] = React.useState(366);
  const width = React.useRef(new Animated.Value(44)).current;
  const keyboardHeight = useKeyboardState((state) => state.height);
  const keyboardLift = Platform.OS !== 'web' && focused && open ? keyboardHeight : 0;
  const bottom = keyboardLift > 0
    ? (keyboardAvoidedByParent ? 12 : keyboardLift + 12)
    : insets.bottom + (kind === 'computer' ? 12 + 42 + 12 : 12);
  const transcriptMaxHeight = Math.max(0, Math.min(
    windowHeight * 0.4, windowHeight - insets.top - (keyboardAvoidedByParent ? keyboardLift : 0) - bottom - pillHeight - 9 - 12,
  ));
  const context = viewerContext(kind, title);
  const currentAgent = viewerAgentHandle(kind, agentHandle, conversation?.messages ?? []);

  React.useEffect(() => {
    if (conversation && !initialTranscriptSeen.current) {
      initialTranscriptSeen.current = true;
      initialIds.current = new Set(conversation.messages.map((message) => message.id));
      return;
    }
    const arrivals = (conversation?.messages ?? []).filter((message: RoomViewMessage) =>
      message.author.kind === 'agent' && message.presentation === 'message' &&
      !initialIds.current.has(message.id) && !receivedIds.current.has(message.id));
    if (!arrivals.length) return;
    for (const message of arrivals) receivedIds.current.add(message.id);
    if (!sentToAgent.current) return;
    const replies = arrivals.filter((message) => !currentAgent ||
      message.author.handle?.replace(/^@/, '') === currentAgent);
    if (!replies.length) return;
    setEntries((current) => [...current, ...replies.map((message) => ({
      id: message.id,
      speaker: message.author.handle ?? message.author.name,
      text: message.text,
    }))].slice(-8));
  }, [conversation?.messages, currentAgent]);

  React.useEffect(() => {
    Animated.timing(width, {
      toValue: open ? Math.max(44, availableWidth) : 44,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [availableWidth, open, width]);

  React.useEffect(() => {
    if (!entries.length) return;
    if (entries.at(-1)?.speaker === 'You') { setTickerVisible(false); return; }
    setTickerVisible(true);
    const timeout = setTimeout(() => setTickerVisible(false), 5500);
    return () => clearTimeout(timeout);
  }, [entries]);

  const send = async (dictated?: DictatedSend) => {
    const text = draftRef.current.trim();
    if (!text || !conversation || sending) return false;
    setSending(true);
    setError(null);
    const previouslySent = sentToAgent.current;
    try {
      const screenshotBase64 = kind === 'computer' ? await captureScreen?.() : undefined;
      if (kind === 'computer' && !screenshotBase64) throw new Error('The browser screen is not ready to capture. Try again.');
      // A fast reply can arrive before the send RPC returns.
      sentToAgent.current = true;
      const succeeded = await conversation.send({
        text, context, agentHandle: currentAgent,
        ...(artifact ? { artifact } : {}),
        ...(screenshotBase64 ? { screenshotBase64 } : {}),
      }, dictated);
      if (!succeeded) { sentToAgent.current = previouslySent; return false; }
      setEntries((current) => [...current, {
        id: `local:${Date.now()}`, speaker: 'You', text, context,
      }].slice(-8));
      setDraft('');
      draftRef.current = '';
      setHeight(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
      setRevision((current) => current + 1);
      return true;
    } catch (caught) {
      sentToAgent.current = previouslySent;
      setError(appErrorCopy(caught, 'Could not send this message.'));
      return false;
    } finally {
      setSending(false);
    }
  };
  const agentReplies = entries.filter((entry) => entry.speaker !== 'You');
  const showTranscript = Boolean(error || (open && entries.length) || (tickerVisible && agentReplies.length));
  const recent = open ? entries.slice(-3) : agentReplies.slice(-2);
  return (
    <View pointerEvents="box-none" style={styles.overlay} testID="viewer-conversation-dock"
    onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width - 24)}>
      {showTranscript ? (
        <View
      style={[styles.transcript, { bottom: bottom + pillHeight + 9 }, { maxHeight: transcriptMaxHeight }]}
      testID="viewer-conversation-transcript"
    >
          <Text style={styles.transcriptHeading}>Recent conversation · {currentAgent ?? 'agent'}</Text>
          {open ? (
            <ScrollView ref={transcriptScroll} style={styles.transcriptScroll}
              testID="viewer-conversation-scroll" keyboardShouldPersistTaps="handled"
              onLayout={scrollToNewest} onContentSizeChange={scrollToNewest}>
              {recent.map((entry) => (
                <View key={entry.id} style={styles.transcriptEntry}>
                  <Text style={styles.transcriptSpeaker}>{entry.speaker}</Text>
                  <MonoMarkdown markdown={entry.text} textStyle={styles.transcriptText} />
                  {entry.context ? (
                    <TranscriptReference viewer>{viewerContextLabel(entry.context)}</TranscriptReference>
                  ) : null}
                </View>
              ))}
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </ScrollView>
          ) : (
            <>
              {recent.map((entry) => (
                <View key={entry.id} style={styles.transcriptEntry}>
                  <Text style={styles.transcriptSpeaker}>{entry.speaker}</Text>
                  <Text numberOfLines={2} style={styles.transcriptText}>{entry.text}</Text>
                  {entry.context ? (
                    <TranscriptReference viewer>{viewerContextLabel(entry.context)}</TranscriptReference>
                  ) : null}
                </View>
              ))}
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </>
          )}
        </View>
      ) : null}
      <Animated.View style={[styles.pill, { width, bottom }]} testID="viewer-conversation-pill"
      onLayout={(event) => setPillHeight(event.nativeEvent.layout.height)}>
        <Button label="" variant="secondary" icon={<ConversationGlyph color={open ? theme.buzz.accent : theme.buzz.textPrimary} />}
        accessibilityRole="button" accessibilityLabel={open ? 'Collapse conversation' : 'Talk to agent'}
        accessibilityState={{ expanded: open }} hitSlop={1}
        onPress={() => {
          if (open) setTickerVisible(false);
          setOpen((value) => !value);
        }}
        style={[styles.control, open && styles.controlOpen]}
        testID="viewer-conversation-toggle"
      />
        {open ? (
          <View style={styles.composerWrap}><ConversationComposer
        viewerPill value={draft} height={height} focused={focused} disabled={sending || !conversation}
        inputRevision={revision} testIDPrefix="viewer" speechEnabled
        onBlur={() => setFocused(false)} onFocus={() => setFocused(true)}
        onChangeText={(text) => { draftRef.current = text; setDraft(text); }}
        onContentSizeChange={(event) => setHeight(draft.trim()
          ? Math.max(COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
              Math.min(120, Math.ceil(event.nativeEvent.contentSize.height)))
          : COMPOSER_SINGLE_LINE_INPUT_HEIGHT)}
        onKeyPress={(event) => { if (Platform.OS === 'web' && event.nativeEvent.key === 'Enter' &&
          !(event.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey) {
          event.preventDefault(); void send();
        } }}
        onSend={send}
      /></View>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 20 },
  pill: {
    position: 'absolute',
    right: 12,
    minHeight: 44,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgRaised,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  control: {
    // The enclosing 1 dp border completes the 44 dp closed square.
    width: 42,
    minWidth: 42,
    height: 42,
    minHeight: 42,
    borderWidth: 0,
    paddingHorizontal: 0,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlOpen: { width: 44, minWidth: 44, height: 'auto', alignSelf: 'stretch', borderRightWidth: 1, borderRightColor: theme.buzz.borderStrong, borderRadius: 0,
    backgroundColor: 'transparent' },
  composerWrap: { flex: 1, minWidth: 0 },
  transcript: { overflow: 'hidden', position: 'absolute', left: 16, right: 16, padding: theme.buzz.space.md, borderRadius: 10,
    borderWidth: 1, borderColor: theme.buzz.borderStrong,
    backgroundColor: withAlpha(theme.buzz.bgRaised, 0.8) },
  transcriptScroll: { flexShrink: 1, minHeight: 0 },
  transcriptHeading: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet, marginBottom: theme.buzz.space.sm },
  transcriptEntry: { marginTop: 4 },
  transcriptSpeaker: { ...theme.buzz.type.machine, color: theme.buzz.accent },
  transcriptText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  error: { ...theme.buzz.type.body, color: theme.buzz.dialogDanger, marginTop: 4 },
}));
