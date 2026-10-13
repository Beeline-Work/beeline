import { Button } from './Button';
import React from 'react';
import { Animated, Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { currentViewerConversation, subscribeViewerConversation, viewerAgentHandle, viewerContext, viewerContextLabel } from '@/buzz/viewer-conversation';
import { withAlpha } from '@/buzz/groknight';
import { MAX_MESSAGE_ATTACHMENTS, pickedPhotoAttachments, type PickedChatAttachment } from '@/buzz/chat-attachment-pick';
import { COMPOSER_SINGLE_LINE_INPUT_HEIGHT, ConversationComposer, type DictatedSend } from '@/components/buzz/ConversationComposer';
import { TranscriptReference, ViewerConversationRing } from './TranscriptReference';
import { AttachmentPickerSheet } from './AttachmentPickerSheet';

type Entry = { id: string; speaker: string; text: string; context?: string };

/** Small conversation controls that float above a full-height viewer. */
export function ViewerConversationDock({
  kind, title, roomId, agentHandle, artifact, captureScreen,
}: {
  kind: 'artifact' | 'computer';
  title: string;
  roomId?: string;
  agentHandle?: string;
  artifact?: AttachmentReference;
  captureScreen?: () => Promise<string | null>;
}) {
  const insets = useSafeAreaInsets();
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
  const [attachPicker, setAttachPicker] = React.useState(false);
  const [attachments, setAttachments] = React.useState<PickedChatAttachment[]>([]);
  // One slot belongs to the artifact or browser snapshot attached at send time.
  const maxPickedAttachments = MAX_MESSAGE_ATTACHMENTS - 1;
  const [availableWidth, setAvailableWidth] = React.useState(366);
  const width = React.useRef(new Animated.Value(44)).current;
  const bottom = insets.bottom + (kind === 'computer' ? 12 + 42 + 12 : 12);
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
    if ((!text && !attachments.length) || !conversation || sending) return false;
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
        ...(attachments.length ? { pickedAttachments: attachments } : {}),
      }, dictated);
      if (!succeeded) { sentToAgent.current = previouslySent; return false; }
      setEntries((current) => [...current, {
        id: `local:${Date.now()}`, speaker: 'You', text, context,
      }].slice(-8));
      setDraft('');
      draftRef.current = '';
      setAttachments([]);
      setHeight(COMPOSER_SINGLE_LINE_INPUT_HEIGHT);
      setRevision((current) => current + 1);
      return true;
    } catch (caught) {
      sentToAgent.current = previouslySent;
      setError(caught instanceof Error ? caught.message : 'Could not send this message.');
      return false;
    } finally {
      setSending(false);
    }
  };
  const pickPhoto = async () => {
    const remaining = maxPickedAttachments - attachments.length;
    if (remaining < 1) return;
    const ImagePicker = await import('expo-image-picker');
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: remaining, quality: 1, exif: false,
    });
    if (!picked.canceled) setAttachments((current) => [...current, ...pickedPhotoAttachments(picked.assets)].slice(0, maxPickedAttachments));
  };
  const pickDocument = async () => {
    if (attachments.length >= maxPickedAttachments) return;
    const DocumentPicker = await import('expo-document-picker');
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: '*/*' });
    if (picked.canceled || !picked.assets[0]) return;
    const file = picked.assets[0];
    setAttachments((current) => [...current, {
      uri: file.uri, name: file.name || `file-${Date.now()}`,
      mimeType: file.mimeType ?? 'application/octet-stream', size: file.size ?? 0, source: 'file',
    }]);
  };

  const agentReplies = entries.filter((entry) => entry.speaker !== 'You');
  const showTranscript = Boolean(error || (open && entries.length) || (tickerVisible && agentReplies.length));
  const recent = open ? entries.slice(-3) : agentReplies.slice(-2);
  return (
    <View pointerEvents="box-none" style={styles.overlay} testID="viewer-conversation-dock"
    onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width - 24)}>
      {showTranscript ? (
        <View
      style={[styles.transcript, { bottom: bottom + pillHeight + 9 }]}
      testID="viewer-conversation-transcript"
    >
          <Text style={styles.transcriptHeading}>Recent conversation · {currentAgent ?? 'agent'}</Text>
          {recent.map((entry) => (
            <View key={entry.id} style={styles.transcriptEntry}>
              <Text style={styles.transcriptSpeaker}>{entry.speaker}</Text>
              <Text numberOfLines={open ? undefined : 2} style={styles.transcriptText}>{entry.text}</Text>
              {entry.context ? (
                <TranscriptReference viewer>{viewerContextLabel(entry.context)}</TranscriptReference>
              ) : null}
            </View>
          ))}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      ) : null}
      <Animated.View style={[styles.pill, { width, bottom }]} testID="viewer-conversation-pill"
      onLayout={(event) => setPillHeight(event.nativeEvent.layout.height)}>
        <Button label="" variant="secondary" icon={<ViewerConversationRing />}
        accessibilityRole="button" accessibilityLabel={open ? 'Collapse conversation' : 'Talk to agent'}
        accessibilityState={{ expanded: open }}
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
        attachments={attachments.map((item) => ({
          uri: item.uri, name: item.name, mimeType: item.mimeType,
          sizeLabel: `${Math.max(1, Math.round(item.size / 1024))} KB`, uploadState: 'uploaded',
        }))}
        onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, at) => at !== index))}
        onAttach={() => setAttachPicker(true)}
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
      <AttachmentPickerSheet visible={attachPicker} onClose={() => setAttachPicker(false)}
      onPickDocument={() => void pickDocument()} onPickPhoto={() => void pickPhoto()} />
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
    width: 44,
    height: 44,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgBase,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlOpen: { borderRightWidth: 1, borderRightColor: theme.buzz.border, borderRadius: 0,
    backgroundColor: 'transparent' },
  composerWrap: { flex: 1, minWidth: 0 },
  transcript: { position: 'absolute', left: 16, right: 16, padding: theme.buzz.space.md, borderRadius: 10,
    borderWidth: 1, borderColor: theme.buzz.borderStrong,
    backgroundColor: withAlpha(theme.buzz.bgRaised, 0.8) },
  transcriptHeading: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet, marginBottom: theme.buzz.space.sm },
  transcriptEntry: { marginTop: 4 },
  transcriptSpeaker: { ...theme.buzz.type.machine, color: theme.buzz.accent },
  transcriptText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  error: { ...theme.buzz.type.body, color: theme.buzz.dialogDanger, marginTop: 4 },
}));
