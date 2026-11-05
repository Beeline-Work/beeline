import type { MessageSendState } from '@/buzz/message-outbox';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import TranscriptSwipeable, { type TranscriptSwipeableMethods as SwipeableMethods } from '@/components/buzz/TranscriptSwipeable';
import { DesktopMessageAction } from '@/components/buzz/DesktopMessageAction';
import { ButtonRowFrame } from '@/components/buzz/ButtonRow';
import { DesktopWorkspacePortal } from '@/components/buzz/DesktopWorkspacePortal';
import { MESSAGE_REACTION_EMOJIS, type AttachmentReference, type MessageReactionEmoji } from '@beeline/buzz-client';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import { type MessageReplyDisplayTarget } from '@/buzz/message-reply';
import { displayModel } from '@/buzz/model-display';
import { currentViewerConversation, subscribeViewerConversation, viewerContextLabel } from '@/buzz/viewer-conversation';
import { type ConnectorReceipt } from '@/buzz/connector-receipt';
import { attachmentOpenUrl, formatAttachmentSize } from '@/buzz/chat-attachment';
import { mediaIdFromUrl } from '@/buzz/artifact';
import { ArtifactImage } from '@/components/buzz/ArtifactMedia';
import { TranscriptReference } from '@/components/buzz/TranscriptReference';
import { openComputerSessionViewer } from '@/components/buzz/ComputerSession';
import { openArtifactViewer } from '@/components/buzz/ArtifactCard';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { showPictureActions } from '@/buzz/picture-actions';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { CornerGlyph } from '@/components/buzz/CornerGlyph';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { ContentTarget } from '@/components/buzz/IndexRow';
import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/open-external-url';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { ALIVE_RING_PAD } from '@/buzz/identity-mark';
import { styles } from './RoomMessageVariants-ordinary-ledger-message';



/**
 * Attachment bytes are kept for 24 hours (`apps/server/src/media-ttl.ts`); the
 * message that carried them is kept forever. Past the window the server marks
 * the attachment `expired`, and the row says so in the same metrics as a live
 * one — the name, type and size the message still holds, inscribed rather than
 * framed. Nothing is fetched and nothing opens: there is no longer a file
 * behind the link, and a broken thumbnail or a spinner would say otherwise.
 */
export function AttachmentCard({
  attachment,
  isDesktop,
  visible,
}: {
  attachment: AttachmentReference;
  isDesktop: boolean;
  visible: boolean;
}) {
  const image =
    visible && !attachment.expired && attachment.mimeType.startsWith('image/') && mediaIdFromUrl(attachment.url);
  const open = () => {
    // A picture opens the same centered full-screen viewer on every surface,
    // desktop included; the work pane keeps only its documents.
    if (attachment.mimeType.startsWith('image/')) {
      const objectId = mediaIdFromUrl(attachment.url);
      Modal.show({
        component: ArtifactViewerScreen,
        props: { attachment },
        placement: 'fill',
      });
      return;
    }
    void openExternalUrl(attachmentOpenUrl(attachment)).catch(() => {
      Modal.alert('Could not open attachment', 'The file link could not be opened on this device.');
    });
  };
  const metadata = `${attachment.mimeType.toUpperCase()} · ${formatAttachmentSize(attachment.size)}`;
  if (attachment.expired) {
    return (
      <View
        accessibilityLabel={`Expired attachment ${attachment.name}`}
        style={styles.attachmentCard}
        testID={`chat-attachment-expired-${attachment.name}`}
      >
        <View style={styles.attachmentFileGlyph}>
          <Text style={[styles.attachmentFileGlyphText, styles.attachmentExpired]}>▧</Text>
        </View>
        <View style={styles.attachmentCopy}>
          <Text numberOfLines={1} style={[styles.attachmentName, styles.attachmentExpired]}>
            {attachment.name}
          </Text>
          <Text numberOfLines={1} style={styles.attachmentMeta}>
            EXPIRED · {metadata}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <ContentTarget
      accessibilityLabel={`Open attachment ${attachment.name}`}
      accessibilityRole={attachment.mimeType.startsWith('image/') ? 'button' : 'link'}
      delayLongPress={450}
      onLongPress={
        attachment.mimeType.startsWith('image/')
          ? (event) => {
              event.stopPropagation();
              showPictureActions(attachment);
            }
          : undefined
      }
      onPress={open}
      style={styles.attachmentCard}
      testID={`chat-attachment-${attachment.name}`}
      {...(isDesktop && attachment.mimeType.startsWith('image/')
        ? ({
            onContextMenu: (event: { preventDefault(): void; stopPropagation(): void }) => {
              event.preventDefault();
              event.stopPropagation();
              showPictureActions(attachment);
            },
          } as any)
        : {})}
    >
      {image ? (
        <ArtifactImage
          attachment={attachment}
          fit="cover"
          style={styles.attachmentThumbnail}
          testID={`chat-attachment-thumbnail-${attachment.name}`}
        />
      ) : (
        <View style={styles.attachmentFileGlyph}>
          <Text style={styles.attachmentFileGlyphText}>▧</Text>
        </View>
      )}
      <View style={styles.attachmentCopy}>
        <Text numberOfLines={1} style={styles.attachmentName}>
          {attachment.name}
        </Text>
        <Text numberOfLines={1} style={styles.attachmentMeta}>
          {metadata}
        </Text>
      </View>
      <View style={styles.attachmentOpenGlyph}>
        <ChevronGlyph color={styles.attachmentOpenGlyphInk.color} size={CHEVRON_ROW_SIZE} />
      </View>
    </ContentTarget>
  );
}


export function SwipeToReply({
  children,
  messageId,
  onLongPress,
  onActions,
  onPress,
  onReply,
  onReact,
  onForward,
  onBookmark = () => undefined,
  onReportIssue,
  onSwipeCorner,
  bookmarked = false,
  isDesktop,
  replyOnly = false,
}: {
  children: React.ReactNode;
  messageId: string;
  onLongPress(): void;
  /** Mobile long press — opens the message actions sheet. Desktop long press
   *  keeps its copy shortcut and reaches the same sheet through its buttons. */
  onActions?(): void;
  onPress?(): void;
  onReply?(): void;
  onReact(emoji: MessageReactionEmoji): void;
  onForward(): void;
  onBookmark?(): void;
  /** Report issue — files the message with the Beeline feedback loop. Omitted
   *  where the row offers no report (the desktop work pane's read-only copy). */
  onReportIssue?(): void;
  /** Mobile swipe right — forward the message into a new corner. */
  onSwipeCorner?(): void;
  bookmarked?: boolean;
  isDesktop: boolean;
  replyOnly?: boolean;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const [swipeShown, setSwipeShown] = useState(false);
  const showSwipe = useCallback(() => setSwipeShown(true), []);
  const hideSwipe = useCallback(() => setSwipeShown(false), []);
  useEffect(() => setSwipeShown(false), [messageId]);
  const commitSwipe = (direction: 'left' | 'right') => {
    // TranscriptSwipeable reports the movement direction. Its UI-thread spring
    // can return immediately without the legacy native-driver close timers.
    swipeableRef.current?.close();
    // Install the quote before a composer update can recycle this row.
    if (direction === 'left') onReply?.();
    else onSwipeCorner?.();
  };
  const [desktopActionsVisible, setDesktopActionsVisible] = useState(false);
  const [desktopRowHovered, setDesktopRowHovered] = useState(false);
  const [reactionPickerVisible, setReactionPickerVisible] = useState(false);
  const actionsRef = useRef<View>(null);
  const pickerRef = useRef<View>(null);
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => setReactionPickerVisible(false), [messageId, isDesktop]);
  useLayoutEffect(() => {
    if (!isDesktop || !reactionPickerVisible || Platform.OS !== 'web') {
      setPickerPosition(null);
      return;
    }
    // RN Web rows create stacking contexts. A row-local zIndex cannot clear
    // later messages, and the transcript clips anything below its bottom edge.
    // Measure the real surface in the body portal, then keep it in the viewport.
    const anchor = actionsRef.current as unknown as HTMLElement;
    const picker = pickerRef.current as unknown as HTMLElement;
    if (!anchor || !picker) return;
    const bounds = anchor.getBoundingClientRect();
    const size = picker.getBoundingClientRect();
    const inset = 8;
    const maxTop = Math.max(inset, window.innerHeight - size.height - inset);
    setPickerPosition({
      top: Math.max(inset, Math.min(
        bounds.bottom + size.height <= window.innerHeight - inset
          ? bounds.bottom
          : bounds.top - size.height,
        maxTop,
      )),
      left: Math.max(inset, Math.min(bounds.right - size.width, window.innerWidth - size.width - inset)),
    });
    const dismiss = () => setReactionPickerVisible(false);
    const outside = (event: PointerEvent) => {
      if (!picker.contains(event.target as Node) && !anchor.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    // A scrolled/replaced row must never leave a picker pointing at old content.
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [isDesktop, messageId, reactionPickerVisible]);
  const message = isDesktop ? (
    <Pressable
      accessibilityHint="Long press to copy the entire message"
      accessibilityLabel="Message"
      delayLongPress={450}
      onLongPress={onLongPress}
      onPress={onPress}
      style={isDesktop ? styles.replyDesktopMessage : undefined}
      testID={`copy-message-${messageId}`}
    >
      {children}
    </Pressable>
  ) : (
    <Pressable
      // The long press is the row's action sheet — reactions, copy, reply,
      // forward — so it deliberately claims what native text selection once
      // held on this row; Copy on the sheet is the way to the full text now.
      // Touch end keeps its composer-dismissal job.
      delayLongPress={450}
      onLongPress={onActions}
      onTouchEnd={onPress}
      testID={`copy-message-${messageId}`}
    >
      {children}
    </Pressable>
  );
  if (isDesktop) {
    return (
      <View
        style={styles.replyDesktopRow}
        {...({
          onMouseEnter: () => setDesktopRowHovered(true),
          onMouseLeave: () => setDesktopRowHovered(false),
        } as any)}
      >
        {message}
        <ButtonRowFrame
          ref={actionsRef}
          accessibilityLabel="Message actions"
          style={[
            styles.replyDesktopActions,
            (desktopActionsVisible || desktopRowHovered || reactionPickerVisible) && styles.replyDesktopActionsVisible,
          ]}
          testID={`message-actions-${messageId}`}
        >
          {!replyOnly ? (
            <DesktopMessageAction action="copy" label="Copy message text" tooltip="Copy" onPress={onLongPress} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`copy-button-${messageId}`} />
          ) : null}
          {onReply ? <DesktopMessageAction action="reply" label="Reply to message" tooltip="Reply" onPress={onReply} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`reply-button-${messageId}`} /> : null}
          {!replyOnly ? (
            <>
              <DesktopMessageAction action="react" label="React to message" tooltip="React" onPress={() => setReactionPickerVisible((visible) => !visible)} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`react-button-${messageId}`} />
              <DesktopMessageAction action="bookmark" label={bookmarked ? 'Remove bookmark' : 'Bookmark message'} tooltip={bookmarked ? 'Remove bookmark' : 'Bookmark'} selected={bookmarked} onPress={onBookmark} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`bookmark-button-${messageId}`} />
              {onReportIssue ? (
                <DesktopMessageAction action="report" label="Report an issue with this message" tooltip="Report an issue" onPress={onReportIssue} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`report-button-${messageId}`} />
              ) : null}
              <DesktopMessageAction action="forward" label="Forward message" tooltip="Forward" onPress={onForward} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`forward-button-${messageId}`} />
            </>
          ) : null}
        </ButtonRowFrame>
        {!replyOnly && reactionPickerVisible ? (
          <DesktopWorkspacePortal>
            <ButtonRowFrame
              ref={pickerRef}
              style={[styles.reactionPicker, pickerPosition ?? { opacity: 0 }]}
              testID={`reaction-picker-${messageId}`}
            >
            {MESSAGE_REACTION_EMOJIS.map((emoji) => (
              <Pressable
                accessibilityLabel={`React with ${emoji}`}
                accessibilityRole="button"
                key={emoji}
                onPress={() => {
                  onReact(emoji);
                  setReactionPickerVisible(false);
                }}
                style={({ pressed }) => [
                  styles.reactionPickerChoice,
                  pressed && styles.replyDesktopPressed,
                ]}
                testID={`reaction-choice-${messageId}-${emoji}`}
              >
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </Pressable>
            ))}
            </ButtonRowFrame>
          </DesktopWorkspacePortal>
        ) : null}
      </View>
    );
  }
  const cornerAction = (poseStyle?: object) => (
    <View
      accessibilityLabel={`Forward message to a new ${CORNER_LABEL}`}
      accessibilityElementsHidden={!swipeShown}
      importantForAccessibility={swipeShown ? 'auto' : 'no-hide-descendants'}
      style={[styles.cornerSwipeAction, !swipeShown && styles.swipeActionAtRest, poseStyle]}
      testID={`corner-swipe-action-${messageId}`}
    >
      {swipeShown ? <>
        <CornerGlyph color={styles.cornerSwipeGlyph.color} size={20} />
        <Text style={styles.replySwipeLabel}>{CORNER_LABEL.toUpperCase()}</Text>
      </> : null}
    </View>
  );
  const swipeRow = () => (
    <TranscriptSwipeable
      ref={swipeableRef}
      // Swipeable's container clips (`overflow: 'hidden'`) at the row's content
      // edge, where the byline tile sits — and a live agent's gold ring paints
      // `ALIVE_RING_PAD` outside that tile. The clip box is outset by the ring
      // gutter and the children padded back by the same amount, so the copy
      // column never moves and the whole tile, ring included, stays visible.
      // These third-party style props need plain values: Unistyles web styles
      // hide their properties until a supported host style prop resolves them.
      containerStyle={{ marginHorizontal: -ALIVE_RING_PAD }}
      childrenContainerStyle={{ paddingHorizontal: ALIVE_RING_PAD }}
      dragOffsetFromRightEdge={18}
      friction={1.35}
      onSwipeableWillOpen={commitSwipe}
      onSwipeableClose={hideSwipe}
      onSwipeableOpenStartDrag={showSwipe}
      renderLeftActions={onSwipeCorner ? () => cornerAction() : undefined}
      renderRightActions={onReply ? () => (
        <View
          accessibilityLabel="Reply to message"
          style={styles.replySwipeAction}
          testID={`reply-swipe-action-${messageId}`}
        >
          {swipeShown ? <>
            <Text style={styles.replySwipeGlyph}>↩</Text>
            <Text style={styles.replySwipeLabel}>REPLY</Text>
          </> : null}
        </View>
      ) : undefined}
      enabled={Boolean(onReply || onSwipeCorner)}
      testID={`swipe-reply-${messageId}`}
    >
      {message}
    </TranscriptSwipeable>
  );
  return swipeRow();
}


export interface OrdinaryLedgerMessageProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  /** The model stamped on the message at generation time, rendered verbatim
   *  in the agent byline. Absent keeps the plain `AGENT` word — never a live
   *  roster lookup, which would retro-label old messages with today's setting. */
  agentModel?: string;
  participantsHydrated: boolean;
  personName?: string;
  /** Current person portrait from the roster. Wins over a cached author snapshot. */
  personAvatar?: string;
  personFace?: string;
  viewerPubkey: string;
  /**
   * The speaker is WORKING right now — its own fresh working receipt
   * (`selectWorkingAgents`). Lights the byline's gold ring. Never the
   * delivery availability: an available daemon may not be working yet (C77).
   */
  speakerWorking: boolean;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  firstBylineOfDay?: boolean;
  referencedTarget?: MessageReplyDisplayTarget;
  participantHandles: readonly { pubkey: string; handle: string }[];
  channelIndex: ChannelReferenceIndex;
  deliveryFailed: boolean;
  sendState?: MessageSendState;
  untaggedHint?: boolean;
  onChannelReference(target: ChannelReferenceTarget): void;
  codeRoomId?: string;
  onOpenCode?(messageId: string): void;
  onOpenSource?(roomId: string, messageId: string): void;
  onMention?(participantId: string): void;
  onOpenProfile?(participantId: string, kind?: 'human' | 'agent'): void;
  /** A tap on the row — the composer's "outside" — puts the keyboard away. */
  onTapOutsideComposer?(): void;
  onReply(message: ChatDisplayMessage): void;
  onCopy(text: string): void;
  /** Mobile long press on the row — opens the message actions sheet. */
  onMessageActions?(message: ChatDisplayMessage): void;
  onReact?(message: ChatDisplayMessage, emoji: MessageReactionEmoji): void;
  onForward?(message: ChatDisplayMessage): void;
  onBookmark?(message: ChatDisplayMessage): void;
  /** Report issue: prompt for a note and file the message with the feedback loop. */
  onReportIssue?(message: ChatDisplayMessage): void;
  /** Mobile swipe right — forward the message into a new human-owned corner. */
  onForwardToNewCorner?(message: ChatDisplayMessage): void;
  onCornerProposalDecision?(message: ChatDisplayMessage, decision: 'open' | 'cancel'): void;
  cornerProposalAction?: 'open' | 'cancel' | null;
  /** The human reply that answered this corner proposal, once one exists. */
  cornerProposalAnswer?: { decision: 'open' | 'cancel' | null; handle: string } | null;
  onRetry?(eventId: string): void;
  onDismiss(eventId: string): void;
  /** Read-only @system DMs are a full-width announcement feed, not a chat. */
  announcementFeed?: boolean;
  desktopLayout?: boolean;
}


/** The byline's quiet role tag carries the model the agent serves — the name
 *  already says who the speaker is, so the model REPLACES the old `AGENT`
 *  label rather than sitting beside it (captain ruling 2026-09-15). An agent
 *  with no known model keeps the plain `AGENT` word. */
export function agentBylineLabel(model?: string): string {
  const selectedModel = model?.trim();
  return selectedModel ? displayModel(selectedModel) : 'AGENT';
}


/**
 * The connector receipt card: the structured card a connector DM carries
 * (connection, operation, helper, grant, counts — never a value). The
 * prose above stays a normal ledger entry; the card is the receipt.
 */
export const ConnectorReceiptCard = React.memo(function ConnectorReceiptCard({
  receipt,
  connectorName = 'Trusty Squire',
  identity,
}: {
  receipt: ConnectorReceipt;
  connectorName?: string;
  identity?: ChatDisplayMessage['authorIdentity'];
}) {
  return (
    <View style={styles.connectorReceipt} testID="connector-receipt-card">
      <View style={styles.connectorReceiptIdentity}>
        {identity?.avatar ? (
          <IdentityMark
            kind="human"
            seed={identity.pubkey}
            name={identity.name}
            avatarUrl={identity.avatar}
            size={26}
            testID="connector-receipt-logo"
          />
        ) : null}
        <Text style={styles.connectorReceiptHead}>{identity?.name ?? connectorName}</Text>
      </View>
      <Text style={styles.connectorReceiptLine}>
        {receipt.connection} · {receipt.operation}
        {receipt.helper ? ` · on ${receipt.helper}` : ''}
      </Text>
      <Text style={styles.connectorReceiptLine}>
        {[
          receipt.grant ? `grant ${receipt.grant}` : undefined,
          receipt.calls !== undefined
            ? `${receipt.calls} ${receipt.calls === 1 ? 'call' : 'calls'}`
            : undefined,
          receipt.bytes,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {/* One flat summary string; test assertions read it as a plain prop. */}
      <Text style={styles.connectorReceiptLine} testID="connector-receipt-summary">
        {[
          receipt.connection,
          receipt.operation,
          receipt.helper,
          receipt.grant ? `grant ${receipt.grant}` : undefined,
          receipt.calls !== undefined
            ? `${receipt.calls} ${receipt.calls === 1 ? 'call' : 'calls'}`
            : undefined,
          receipt.bytes,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </View>
  );
});


/** The Room publishes its transcript after paint; subscribe so a browser reference
 * becomes actionable as soon as that authoritative snapshot is available. */
export function ViewerContextReference({ context, attachment, roomId, timestamp, isDesktop, testID }: {
  context: string; attachment?: AttachmentReference; roomId?: string; timestamp: number;
  isDesktop: boolean; testID: string;
}) {
  const conversation = useSyncExternalStore(subscribeViewerConversation,
    () => currentViewerConversation(roomId), () => currentViewerConversation(roomId));
  const browserTitle = context.startsWith('Viewing browser: ')
    ? context.slice('Viewing browser: '.length) : undefined;
  const browserSession = browserTitle ? [...(conversation?.messages ?? [])].reverse()
    .find((entry) => entry.createdAt <= timestamp && entry.computerSession?.title === browserTitle)
    ?.computerSession : undefined;
  return (
    <TranscriptReference viewer testID={testID}
    accessibilityLabel={browserTitle ? 'Open shared browser' : 'Open viewed artifact'}
    onPress={browserSession ? () => void openComputerSessionViewer(browserSession, isDesktop, roomId)
      : !browserTitle && attachment && !attachment.expired
        ? () => openArtifactViewer(attachment, isDesktop, roomId) : undefined}
  >{viewerContextLabel(context)}</TranscriptReference>
  );
}
