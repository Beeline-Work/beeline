import { useArtifactRowVisible } from '@/buzz/artifact-viewport';
import { Ionicons } from '@expo/vector-icons';
import { LedgerUntaggedHint } from '@/components/buzz/Ledger';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { agentActivityReplyExcerpt, canBeginReply } from '@/buzz/message-reply';
import { resolvePendingAgentDisplay } from '@/buzz/agent-display';
import { fallbackMemberName } from '@/buzz/member-display';
import { CHANNEL_MENTION_HANDLE, SYSTEM_MENTION_HANDLE, hasChannelMentionToken } from '@/buzz/room-participants';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { emojiTextStyle } from '@/buzz/emoji-text';
import { shouldShowReplyReference } from '@/buzz/reply-reference';
import { draftRequestId, provisionalDraftKey, rememberProvisionalDraft, takeProvisionalDraft } from '@/buzz/draft-settle';
import { liveDraftDrainStore } from '@/buzz/live-draft-drain';
import { splitLedgerText } from '@/buzz/ledger-text';
import { splitViewerContext } from '@/buzz/viewer-conversation';
import { parseConnectorReceipt } from '@/buzz/connector-receipt';
import { ledgerStamp } from '@/buzz/relative-time';
import { isLedgerDayOpener } from '@/buzz/message-dates';
import { useTranscriptStamp } from '@/buzz/use-transcript-stamp';
import { artifactFormat } from '@/buzz/artifact';
import { TranscriptReference } from '@/components/buzz/TranscriptReference';
import { ArtifactCard } from '@/components/buzz/ArtifactCard';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { openExternalUrl } from '@/utils/open-external-url';
import { ActivityTimeline, TurnStepsLine } from '@/components/buzz/ActivityTimeline';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { MessageReactionRoster } from '@/components/buzz/MessageReactionRoster';
import { parseCornerProposal } from '@/buzz/corner-proposal';
import { LedgerEntry, LedgerGhostLine, LedgerSystemLine, LedgerSteer, type LedgerByline } from '@/components/buzz/Ledger';
import { NewMessageMaterialize } from '@/components/buzz/MonoHull';
import { TranscriptCard } from '@/components/buzz/TranscriptCard';
import { forwardedMessageParts } from '@/buzz/message-forward';
import { agentMessageJsonMarkdown } from '@/buzz/agent-message-json';
import { OrdinaryLedgerMessageProps, agentBylineLabel, SwipeToReply, ConnectorReceiptCard, AttachmentCard, ViewerContextReference } from './RoomMessageVariants-attachment-card';



export const OrdinaryLedgerMessage = React.memo(function OrdinaryLedgerMessage({
  message,
  agent,
  agentModel,
  participantsHydrated,
  personName,
  personAvatar,
  personFace,
  viewerPubkey,
  speakerWorking,
  continued,
  immediatelyPrecedingMessage,
  firstBylineOfDay,
  referencedTarget,
  participantHandles,
  channelIndex,
  deliveryFailed,
  sendState,
  untaggedHint = false,
  onChannelReference,
  codeRoomId,
  onOpenCode,
  onOpenSource,
  onMention,
  onOpenProfile,
  onTapOutsideComposer,
  onReply,
  onCopy,
  onMessageActions,
  onReact = () => undefined,
  onForward = () => undefined,
  onBookmark = () => undefined,
  onReportIssue,
  onForwardToNewCorner,
  onCornerProposalDecision,
  cornerProposalAction = null,
  cornerProposalAnswer = null,
  onDismiss,
  announcementFeed = false,
  desktopLayout = false,
}: OrdinaryLedgerMessageProps) {
  const artifactVisible = useArtifactRowVisible(message.id, Boolean(message.attachments?.some(attachment => !attachment.expired)));
  const replyAvailable = canBeginReply(message, codeRoomId ?? message.reference?.channelId ?? '');
  const isOwn = message.isUser;
  const indexedAuthor = message.authorIdentity;
  // A loaded roster entry is the current identity. Historical rows may still
  // carry the face or generated avatar that was current when they were cached,
  // including artwork the agent has since removed.
  const speakerFace = agent ? agent.face : (personFace ?? indexedAuthor?.face);
  const speakerAvatar = agent ? agent.avatar : (personAvatar ?? indexedAuthor?.avatar);
  const currentAgent =
    indexedAuthor?.kind === 'agent'
      ? {
          pubkey: indexedAuthor.pubkey,
          displayName: indexedAuthor.name,
          ...(indexedAuthor.avatar ? { avatar: indexedAuthor.avatar } : {}),
          ...(agent?.soulProfile ? { soulProfile: agent.soulProfile } : {}),
          // This row's own server identity names the face first; the roster
          // entry fills it in for a row the index has not identified.
          ...(speakerFace ? { face: speakerFace } : {}),
        }
      : agent;
  const isAgent =
    indexedAuthor?.kind === 'agent' ||
    message.isAgentAuthor ||
    message.isAgentActivity ||
    Boolean(currentAgent);
  const cornerProposal =
    isAgent && !message.isAgentActivity && !message.isAgentDraft
      ? parseCornerProposal(message.text)
      : null;
  const display = isAgent
    ? resolvePendingAgentDisplay(
        message.pubkey ?? indexedAuthor?.pubkey ?? 'unknown-agent',
        currentAgent,
        participantsHydrated,
      )
    : null;
  const isSelfSteer = isOwn && !isAgent;
  const dayOpener = isLedgerDayOpener(message.timestamp, immediatelyPrecedingMessage?.timestamp);
  const bylineOpener = firstBylineOfDay ?? dayOpener;
  const stamp = useTranscriptStamp(message.timestamp, bylineOpener && !message.isAgentActivity);
  const continuedRun = continued && !bylineOpener;
  const voiceName = isAgent
    ? (indexedAuthor?.name ??
      display?.name ??
      personName ??
      fallbackMemberName(message.pubkey ?? ''))
    : (indexedAuthor?.name ??
      personName ??
      (message.pubkey ? fallbackMemberName(message.pubkey) : 'SOMEONE'));
  const markSeed = message.pubkey ?? (isSelfSteer ? viewerPubkey || 'self' : 'unknown-person');
  const byline: LedgerByline | undefined =
    continuedRun &&
    !isAgent &&
    !announcementFeed &&
    !message.bookmarked &&
    !message.feedbackReported
      ? undefined
      : {
          // The viewer is named like every other speaker. Brass on the name
          // (`isViewer`, drawn in Ledger.tsx) is the ONE thing that marks
          // them; a "You" caption beside it says the same thing twice and
          // breaks the run of names down the left edge.
          name: voiceName,
          onOpenProfile:
            !announcementFeed && message.pubkey && onOpenProfile
              ? () =>
                  isAgent ? onOpenProfile(message.pubkey!) : onOpenProfile(message.pubkey!, 'human')
              : undefined,
          // The byline is a nested profile Pressable. Giving that Pressable
          // the row's long-press action makes React Native cancel its onPress
          // on release instead of navigating behind the actions sheet.
          onLongPress: onMessageActions ? () => onMessageActions(message) : undefined,
          role: isAgent ? agentBylineLabel(agentModel) : undefined,
          stamp,
          isViewer: isSelfSteer,
          bookmarked: message.bookmarked,
          feedbackReported: message.feedbackReported,
          ...(announcementFeed
            ? {}
            : {
                mark: {
                  seed: markSeed,
                  kind: isAgent ? ('agent' as const) : ('human' as const),
                  ...(speakerFace ? { face: speakerFace } : {}),
                  ...(speakerAvatar ? { avatarUrl: speakerAvatar } : {}),
                  ...(isAgent ? { alive: speakerWorking } : {}),
                },
              }),
        };
  // A row with no activity of its own still has its text to show, so it is
  // lifted into one `output` item — which `buildTurnActivity` renders as
  // narration, at the settled tier. A LIVE DRAFT is the one row that must
  // never take that path: its words are provisional, they are already rendered
  // in the provisional face through `messageDraft`, and promoting them here
  // printed the same unfinished sentence twice, the first copy dressed as the
  // durable reply.
  const activity = useMemo(
    () =>
      message.activity?.length
        ? message.activity
        : message.isAgentDraft
          ? []
          : [{ kind: 'output' as const, title: 'Output', text: message.text }],
    [message.activity, message.isAgentDraft, message.text],
  );
  // What the reader is being shown while the turn writes, remembered under the
  // turn's own request id. The durable reply below collects it and fades out
  // of it; nothing about the draft itself changes (C98).
  const draftKey =
    message.pubkey && (message.agentMessageDraft || message.agentMessageDraftKey)
      ? draftRequestId(message.id)
      : undefined;
  useEffect(() => {
    if (!draftKey || !message.pubkey) return;
    const text =
      message.agentMessageDraft ??
      (message.agentMessageDraftKey
        ? liveDraftDrainStore.getReceived(message.agentMessageDraftKey)
        : '');
    if (!text) return;
    rememberProvisionalDraft(provisionalDraftKey(message.pubkey, draftKey), text);
  }, [draftKey, message.agentMessageDraft, message.agentMessageDraftKey, message.pubkey]);
  // Spent once per settled reply, and decided once per mounted row: a
  // re-render mid-transition must not restart or cancel the dissolve.
  const settleRef = useRef<string | undefined>(undefined);
  if (settleRef.current === undefined) {
    settleRef.current =
      isAgent && message.requestId && message.pubkey && !message.isAgentActivity
        ? (takeProvisionalDraft(provisionalDraftKey(message.pubkey, message.requestId)) ?? '')
        : '';
  }
  const settleFrom = settleRef.current || undefined;
  const taggedMentionPubkeys = useMemo(
    () => new Set(message.mentionPubkeys ?? []),
    [message.mentionPubkeys],
  );
  const mentionHandles = useMemo(() => {
    const handles = participantHandles
      .filter((participant) => taggedMentionPubkeys.has(participant.pubkey) ||
        (isAgent && message.text.toLocaleLowerCase().includes(`@${participant.handle.toLocaleLowerCase()}`)))
      .map((participant) => participant.handle);
    // `@channel` is sent as one literal token, never expanded into names, so
    // it is highlighted by its own reserved handle rather than a roster hit.
    if (hasChannelMentionToken(message.text)) handles.push(CHANNEL_MENTION_HANDLE);
    if (message.text.toLocaleLowerCase().includes('@system')) handles.push(SYSTEM_MENTION_HANDLE);
    return handles;
  }, [participantHandles, taggedMentionPubkeys, message.text, isAgent]);
  const handleMention = useCallback(
    (handle: string) => {
      if (handle === SYSTEM_MENTION_HANDLE) {
        onMention?.(SYSTEM_IDENTITY_PUBKEY);
        return;
      }
      const participant = participantHandles.find(
        (candidate) =>
          candidate.pubkey !== viewerPubkey &&
          (taggedMentionPubkeys.has(candidate.pubkey) || isAgent) &&
          candidate.handle.normalize('NFKC').toLocaleLowerCase() === handle,
      );
      if (participant) onMention?.(participant.pubkey);
    },
    [onMention, participantHandles, taggedMentionPubkeys, viewerPubkey, isAgent],
  );
  if (message.isAgentActivity) {
    const excerpt = agentActivityReplyExcerpt(message);
    return (
      <View style={styles.activityGroup} testID="corner-activity">
        <SwipeToReply
          messageId={message.id}
          onLongPress={() => onCopy(excerpt)}
          onActions={onMessageActions ? () => onMessageActions(message) : undefined}
          {...(onTapOutsideComposer ? { onPress: onTapOutsideComposer } : {})}
          onReply={replyAvailable ? () => onReply(message) : undefined}
          onReact={() => undefined}
          onForward={() => undefined}
          isDesktop={desktopLayout}
          replyOnly
        >
          <ActivityTimeline
            active={message.isAgentLiveTurn === true}
            chronological={desktopLayout}
            handle={!continuedRun && isAgent ? voiceName : undefined}
            role={agentBylineLabel(agentModel)}
            mark={
              !continuedRun && isAgent
                ? {
                    seed: markSeed,
                    kind: 'agent',
                    // Same axes the settled byline mark renders (its creature,
                    // and working → gold ring): the streaming lane is the same
                    // speaker, so it must not wear a different animal for the
                    // length of the turn.
                    ...(speakerFace ? { face: speakerFace } : {}),
                    ...(speakerAvatar ? { avatarUrl: speakerAvatar } : {}),
                    alive: message.isAgentLiveTurn === true,
                  }
                : undefined
            }
            items={activity}
            messageDraft={message.agentMessageDraft}
            messageDraftKey={message.agentMessageDraftKey}
            stamp={ledgerStamp(message.timestamp)}
            testID="corner-activity-timeline"
          />
        </SwipeToReply>
      </View>
    );
  }

  const showReplyReference = shouldShowReplyReference({
    replyToId: message.replyToId,
    speaksAsAgent: isAgent,
    immediatelyPrecedingMessage,
  });
  const replySourceRoomId = message.reference?.channelId ?? codeRoomId;
  const replySourceMessageId = message.replyToId;
  const replyReference = showReplyReference ? (
    <TranscriptReference
      accessibilityLabel="Open original message"
      onPress={onOpenSource && replySourceRoomId && replySourceMessageId
        ? () => onOpenSource(replySourceRoomId, replySourceMessageId) : undefined}
      testID={`reply-reference-${message.id}`}
    >
      ↳ {referencedTarget?.authorName ?? 'ORIGINAL MESSAGE'} ·{' '}
      {referencedTarget?.preview ?? 'Message not loaded'}
    </TranscriptReference>
  ) : null;
  const forwarded = forwardedMessageParts(message.text);
  const forwardSource = forwarded.source;
  const forwardBodyAction =
    forwardSource && onOpenSource
      ? {
          accessibilityLabel: 'Open original forwarded message',
          onPress: () => onOpenSource(forwardSource.roomId, forwardSource.messageId),
          testID: `forward-source-${message.id}`,
        }
      : undefined;
  const connectorReceipt = parseConnectorReceipt(forwarded.body);
  const receiptBody = connectorReceipt ? connectorReceipt.prose : forwarded.body;
  const viewerMessage = !isAgent ? splitViewerContext(receiptBody) : { body: receiptBody };
  const ledgerText = isSelfSteer ? undefined : splitLedgerText(viewerMessage.body);
  const proseBody = ledgerText ? ledgerText.prose : viewerMessage.body;
  const renderedBody = isAgent ? (agentMessageJsonMarkdown(proseBody) ?? proseBody) : proseBody;
  const receiptCard =
    connectorReceipt && !isSelfSteer ? (
      <ConnectorReceiptCard receipt={connectorReceipt.receipt} identity={message.authorIdentity} />
    ) : null;
  const ghostLine = ledgerText?.machine ? (
    <LedgerGhostLine
      body={ledgerText.machine}
      label={`${ledgerText.machineLines} lines of tool output`}
      testID={`chat-machine-noise-${message.id}`}
    />
  ) : null;
  // A Room reply carries its turn's steps — tool calls and the text written
  // before the answer — and shows them folded under the prose.
  const stepsLine =
    isAgent && message.activity?.length ? (
      <TurnStepsLine items={message.activity} testID={`reply-steps-${message.id}`} />
    ) : null;
  const machineNoise =
    ghostLine || stepsLine ? (
      <>
        {ghostLine}
        {stepsLine}
      </>
    ) : null;
  const livePhotoArtifacts = message.attachments?.filter(
    (attachment) =>
      attachment.kind === 'artifact' &&
      !attachment.expired &&
      artifactFormat(attachment.mimeType) === 'image',
  );
  const groupedPhotoArtifacts =
    livePhotoArtifacts && livePhotoArtifacts.length > 1 ? livePhotoArtifacts : undefined;
  const firstGroupedPhoto = groupedPhotoArtifacts?.[0];
  const attachments = message.attachments?.map((attachment, index) => {
    if (viewerMessage.context && index === 0 &&
      (viewerMessage.context.startsWith('Viewing artifact:') || attachment.name === 'browser-screen.jpg')) return null;
    if (attachment.kind === 'artifact' && !attachment.expired) {
      if (groupedPhotoArtifacts && artifactFormat(attachment.mimeType) === 'image') {
        if (attachment !== firstGroupedPhoto) return null;
      }
      return (
        <ArtifactCard
          visible={artifactVisible}
          attachment={attachment}
          authorHandle={
            attachment.author ??
            (message.authorIdentity?.kind === 'agent'
              ? (message.authorIdentity.handle ?? message.authorIdentity.name).replace(/^@/, '')
              : undefined)
          }
          isDesktop={desktopLayout}
          key={`${message.id}-${attachment.url}`}
          {...(attachment === firstGroupedPhoto ? { photoAttachments: groupedPhotoArtifacts } : {})}
        />
      );
    }
    return (
      <AttachmentCard
        visible={artifactVisible}
        attachment={attachment}
        isDesktop={desktopLayout}
        key={`${message.id}-${attachment.url}`}
      />
    );
  });

  const viewerReference = viewerMessage.context ? (
    <ViewerContextReference context={viewerMessage.context} attachment={message.attachments?.[0]}
      roomId={codeRoomId} timestamp={message.timestamp} isDesktop={desktopLayout}
      testID={`viewer-context-${message.id}`} />
  ) : null;
  const messageReference = viewerReference ? (
    <>{replyReference}{viewerReference}</>
  ) : (
    replyReference
  );

  // A local send is tap feedback; never hide it behind the arrival fade.
  const content = (
    <NewMessageMaterialize enabled={Boolean(message.isNew) && !message.isUser} messageId={message.id}>
      <View>
        {isSelfSteer ? (
          <LedgerSteer
            itemId={message.id}
            continued={continuedRun}
            chronological={desktopLayout}
            precededByDayCaption={dayOpener}
            byline={byline}
            bodyText={viewerMessage.body}
            mentionHandles={mentionHandles}
            onMention={handleMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeRoomId={codeRoomId}
            onOpenCode={onOpenCode}
            bodyTestID={`chat-message-text-${message.id}`}
            bodyAction={forwardBodyAction}
            replyReference={messageReference}
            attachments={attachments}
          />
        ) : cornerProposal ? (
          <TranscriptCard
            tier={onCornerProposalDecision && !cornerProposalAnswer ? 'ask' : 'record'}
            testID={`corner-proposal-${message.id}`}
            identity={
              <IdentityMark
                kind="agent"
                seed={markSeed}
                avatarUrl={speakerAvatar}
                face={speakerFace}
                name={voiceName}
                size={26}
              />
            }
            title={`Proposed ${CORNER_LABEL}: ${cornerProposal.title}`}
            wrapTitle
            subline={cornerProposal.objective}
            stamp={ledgerStamp(message.timestamp)}
            body={cornerProposal.warnings.length ? cornerProposal.warnings.join('\n') : undefined}
            quietBody
            choices={(
              [
                ['open', 'A', `Open ${CORNER_LABEL}`],
                ['cancel', 'B', 'Cancel'],
              ] as const
            ).map(([decision, letter, label]) => ({
              id: `corner-proposal-${decision}-${message.id}`,
              letter,
              label,
              consequence: '',
              selected: (cornerProposalAnswer?.decision ?? cornerProposalAction) === decision,
              ...(onCornerProposalDecision && !cornerProposalAnswer && !cornerProposalAction
                ? { onPress: () => onCornerProposalDecision(message, decision) }
                : {}),
            }))}
            footerNote={
              cornerProposalAnswer
                ? `${
                    cornerProposalAnswer.decision === 'open'
                      ? 'opened'
                      : cornerProposalAnswer.decision === 'cancel'
                        ? 'cancelled'
                        : 'answered'
                  } · @${cornerProposalAnswer.handle}`
                : undefined
            }
            footerNoteTestID={`corner-proposal-footer-${message.id}`}
          />
        ) : message.awayWarning ? (
          <TranscriptCard tier="record" testID="away-warning-card" wrapTitle
            title="Schedules and subscriptions will pause in 1 day"
            body={message.text} stamp={ledgerStamp(message.timestamp)} />
        ) : (message.authorIdentity?.pubkey ?? message.pubkey) === SYSTEM_IDENTITY_PUBKEY ? (
          <LedgerSystemLine
            id={message.id}
            text={renderedBody}
            {...(message.systemEvent ? { event: message.systemEvent } : {})}
            stamp={ledgerStamp(message.timestamp)}
            onOpenUrl={(url) => void openExternalUrl(url).catch(() => undefined)}
          />
        ) : (
          <LedgerEntry
            itemId={message.id}
            byline={byline}
            continued={continuedRun}
            chronological={desktopLayout}
            precededByDayCaption={dayOpener}
            luminous={isAgent && !announcementFeed}
            typewriter={isAgent && !announcementFeed && Boolean(message.isNew)}
            settleFrom={settleFrom}
            bodyText={renderedBody}
            mentionHandles={mentionHandles}
            onMention={handleMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            codeRoomId={codeRoomId}
            onOpenCode={onOpenCode}
            bodyTestID={`chat-message-text-${message.id}`}
            bodyAction={forwardBodyAction}
            replyReference={messageReference}
            machineNoise={machineNoise}
            attachments={attachments}
          />
        )}
        {receiptCard}
        {forwarded.caption ? (
          forwardSource && onOpenSource ? (
            <Pressable
              accessibilityLabel="Open original forwarded message"
              accessibilityRole="button"
              onPress={() => onOpenSource(forwardSource.roomId, forwardSource.messageId)}
              testID={`forward-source-caption-${message.id}`}
            >
              <Text style={styles.forwardCaption} testID={`forward-caption-${message.id}`}>
                {forwarded.caption}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.forwardCaption} testID={`forward-caption-${message.id}`}>
              {forwarded.caption}
            </Text>
          )
        ) : null}
        {untaggedHint && isSelfSteer && !deliveryFailed &&
          (message.pubkey ?? indexedAuthor?.pubkey) === viewerPubkey ? (
          <LedgerUntaggedHint messageId={message.id} />
        ) : null}
        {/* A pending send looks sent; only a failure gets a line. */}
        {message.isUser && sendState && sendState.kind !== 'sending' ? (
          <ErrorBanner inline
            title={sendState.text}
            icon={<Ionicons name="alert-circle-outline" size={13} color={styles.sendFailure.color} />}
            secondaryAction={{ label: 'Dismiss', onPress: () => onDismiss(message.id) }}
            testID={`outbox-delivery-failed-${message.id}`}
          />
        ) : null}
        {message.reactions?.length ? (
          <View style={styles.reactionChips} testID={`reaction-chips-${message.id}`}>
            {message.reactions.map((reaction) => (
              <MessageReactionRoster
                desktop={desktopLayout}
                key={reaction.emoji}
                messageId={message.id}
                onReact={() => onReact(message, reaction.emoji)}
                reaction={reaction}
              />
            ))}
          </View>
        ) : null}
      </View>
    </NewMessageMaterialize>
  );
  if (announcementFeed) return content;
  return (
    <SwipeToReply
      messageId={message.id}
      onLongPress={() => onCopy(message.text)}
      onActions={onMessageActions ? () => onMessageActions(message) : undefined}
      {...(onTapOutsideComposer ? { onPress: onTapOutsideComposer } : {})}
      onReply={replyAvailable ? () => onReply(message) : undefined}
      onReact={(emoji) => onReact(message, emoji)}
      onForward={() => onForward(message)}
      onBookmark={() => onBookmark(message)}
      {...(onReportIssue && !message.isAgentDraft && !message.isAgentActivity
        ? { onReportIssue: () => onReportIssue(message) }
        : {})}
      {...(onForwardToNewCorner && !message.isAgentDraft
        ? // A message someone else wrote can carry the swipe-to-corner tip.
          { onSwipeCorner: () => onForwardToNewCorner(message) }
        : {})}
      bookmarked={message.bookmarked}
      isDesktop={desktopLayout}
    >
      {content}
    </SwipeToReply>
  );
});


export const styles = StyleSheet.create((theme) => ({
  activityGroup: { width: '100%', minWidth: 0 },
  connectorReceipt: {
    marginTop: 4,
    marginHorizontal: 8,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: 3,
    padding: 8,
    gap: theme.buzz.space.xs,
  },
  connectorReceiptHead: {
    ...Typography.mono('semiBold'),
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.textSecondary,
  },
  connectorReceiptIdentity: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  connectorReceiptLine: {
    ...Typography.mono(),
    ...theme.buzz.type.machine,
    color: theme.buzz.textSecondary,
  },
  replyDesktopRow: { position: 'relative', flexDirection: 'row', alignItems: 'flex-start' },
  replyDesktopMessage: { flex: 1, minWidth: 0 },
  replyDesktopActions: {
    position: 'absolute',
    top: 0,
    right: 0,
    flexDirection: 'row',
    opacity: 0,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgTerminal,
  },
  replyDesktopActionsVisible: { opacity: 1 },
  replyDesktopPressed: { backgroundColor: theme.buzz.bgHighlight },
  reactionPicker: {
    position: 'fixed' as any,
    zIndex: 4,
    flexDirection: 'row',
    padding: 4,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgTerminal,
  },
  reactionPickerChoice: {
    width: 36,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.buzz.space.sm,
    marginTop: theme.buzz.space.xs,
    marginBottom: theme.buzz.space.xs,
    marginLeft: 8,
  },
  reactionEmoji: emojiTextStyle(theme.buzz.type.body),
  sendFailure: { color: theme.buzz.dialogDanger },
  forwardCaption: {
    ...theme.buzz.type.sectionHead,
    marginTop: theme.buzz.space.xs,
    marginLeft: 8,
    color: theme.buzz.ledgerQuiet,
  },
  replySwipeAction: {
    width: 78,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgHighlight,
  },
  cornerSwipeAction: {
    width: 78,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgHighlight,
  },
  cornerSwipeGlyph: { color: theme.buzz.accent },
  // Keeps the panel's width, which Swipeable measures for its open distance.
  swipeActionAtRest: { opacity: 0 },
  replySwipeGlyph: {
    ...theme.buzz.type.body,
    fontFamily: theme.buzz.proseSemibold,
    color: theme.buzz.textPrimary,
  },
  replySwipeLabel: {
    ...theme.buzz.type.sectionHead,
    fontFamily: theme.buzz.monoSemibold,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.textMuted,
  },
  attachmentCard: {
    minWidth: 0,
    width: '100%',
    minHeight: 58,
    marginTop: 8,
    paddingVertical: theme.buzz.space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
  },
  attachmentThumbnail: { width: 46, height: 46, backgroundColor: theme.buzz.bgHighlight },
  attachmentFileGlyph: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  attachmentFileGlyphText: { ...theme.buzz.type.hero, color: theme.buzz.steel },
  attachmentCopy: { flex: 1, minWidth: 0 },
  attachmentExpired: { color: theme.buzz.textMuted },
  attachmentName: {
    ...theme.buzz.type.body,
    fontSize: theme.buzz.transcriptCard.rowTitleSize,
    color: theme.buzz.textPrimary,
  },
  attachmentMeta: {
    ...theme.buzz.type.machine,
    fontSize: theme.buzz.transcriptCard.rowKindSize,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.textMuted,
  },
  attachmentOpenGlyph: {
    width: 22,
    alignItems: 'center',
  },
  attachmentOpenGlyphInk: { color: theme.buzz.steel },

replyDesktopLabel: {
    ...theme.buzz.type.sectionHead,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.textMuted,
  },
}));
