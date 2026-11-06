import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useRef, useCallback } from 'react';
import { TextInput, AccessibilityInfo } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type MessageReactionEmoji } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { readChatList } from '@/buzz/chat-list-store';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { fallbackMemberHandle, fallbackMemberName } from '@/buzz/member-display';
import { beginReplyTarget, type MessageReplyDisplayTarget, type MessageReplyTarget } from '@/buzz/message-reply';
import { planReplyPrefill, type ComposerPrefill, type ComposerPrefillPlan } from '@/buzz/composer-prefill';
import { roomMessageRecord, writeRoomBookmark } from '@/buzz/room-message-records';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { promptAndReportMessageIssue, reportIssueToastCopy } from '@/buzz/report-message-issue';
import { forwardMessageToRoom, forwardTargets, resolveForwardTargetRoom, type ForwardTarget } from '@/buzz/message-forward';

type Props = [
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  personProfileByPubkey: Map<string, { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; }>,
  chronologicalMessagesRef: React.RefObject<ChatDisplayMessage[]>,
  decodedId: string,
  setReplyTarget: React.Dispatch<React.SetStateAction<MessageReplyTarget | null>>,
  applyComposerPrefill: (plan: ComposerPrefillPlan, agent?: { handle: string; pubkey: string; }) => void,
  inputTextRef: React.RefObject<string>,
  composerPrefillRef: React.RefObject<ComposerPrefill | null>,
  setDismissedMentionKey: React.Dispatch<React.SetStateAction<string | null>>,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  composerRef: React.RefObject<TextInput | null>,
  reactingRef: React.RefObject<Set<string>>,
  optimisticReactionsRef: React.RefObject<Record<string, readonly import("@beeline/api-contract/phone").MessageReactionView[] | undefined>>,
  setOptimisticReactions: React.Dispatch<React.SetStateAction<Record<string, readonly import("@beeline/api-contract/phone").MessageReactionView[] | undefined>>>,
  applyRoomMessageResult: (message: import("@beeline/api-contract/phone").RoomViewMessage) => void,
  starPrompt: { prompt: import("@beeline/api-contract/phone").StarPrompt | null; busy: import("@beeline/api-contract/phone").StarPromptAction | null; answer: (action: import("@beeline/api-contract/phone").StarPromptAction) => Promise<void>; accept: (view: { prompt: import("@beeline/api-contract/phone").StarPrompt | null; }) => void; },
  messageRecordScope: string | null,
  showReportToast: (message: string) => void,
  canManageWorkspace: boolean,
  setOptimisticDeletes: React.Dispatch<React.SetStateAction<Record<string, true>>>,
  setMessageActionsTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>,
  workspaceChatList: import("@beeline/api-contract/phone").ChatListView | null,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  activeCommunityId: string | null,
  setForwardTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>,
  setForwardRooms: React.Dispatch<React.SetStateAction<readonly ForwardTarget[] | null>>,
  setForwardError: React.Dispatch<React.SetStateAction<string | null>>,
  chatListKey: { relayUrl: string; viewerPubkey: string; workspaceId: string; } | null,
  forwardTarget: ChatDisplayMessage | null,
  forwardBusyRoomId: string | null,
  setForwardBusyRoomId: React.Dispatch<React.SetStateAction<string | null>>,
  transport: BuzzRigTransport | null,
  displayRoomName: string,
  outbox: import("@/app/(app)/beeline/chat/useRoomSurfaceSession").RoomSurfaceOutboxHandle,
];

export function useChatMessageActions([
  agentByPubkey, personProfileByPubkey, chronologicalMessagesRef, decodedId, setReplyTarget,
  applyComposerPrefill, inputTextRef, composerPrefillRef, setDismissedMentionKey, scrollController,
  composerRef, reactingRef, optimisticReactionsRef, setOptimisticReactions, applyRoomMessageResult,
  starPrompt, messageRecordScope, showReportToast, canManageWorkspace, setOptimisticDeletes,
  setMessageActionsTarget, workspaceChatList, roomClient, activeCommunityId, setForwardTarget,
  setForwardRooms, setForwardError, chatListKey, forwardTarget, forwardBusyRoomId,
  setForwardBusyRoomId, transport, displayRoomName, outbox,
]: Props): [
  replyTargetForMessage: (message: ChatDisplayMessage) => MessageReplyDisplayTarget,
  beginForward: (message: ChatDisplayMessage) => Promise<void>,
  beginReply: (message: ChatDisplayMessage) => void,
  openMessageActions: (message: ChatDisplayMessage) => void,
  handleReactToMessage: (message: ChatDisplayMessage, emoji: MessageReactionEmoji) => Promise<void>,
  handleBookmarkMessage: (message: ChatDisplayMessage) => Promise<void>,
  handleReportMessage: (message: ChatDisplayMessage) => Promise<void>,
  dismissOutboxMessage: (eventId: string) => void,
  messageIsBookmarked: (message: ChatDisplayMessage) => boolean,
  canDeleteMessage: (message: ChatDisplayMessage) => boolean,
  handleDeleteMessage: (message: ChatDisplayMessage) => Promise<void>,
  forwardToRoom: (target: ForwardTarget) => Promise<void>,
] {


  const replyTargetForMessage = useCallback(
    (message: ChatDisplayMessage): MessageReplyDisplayTarget => {
      const knownAgent = message.pubkey ? agentByPubkey.get(message.pubkey) : undefined;
      const isAgent = Boolean(
        message.pubkey && (message.isAgentAuthor || message.isAgentActivity || knownAgent),
      );
      const agentDisplay = isAgent
        ? resolveAgentDisplayIdentity(message.pubkey ?? 'unknown-agent', knownAgent)
        : undefined;
      const personProfile = message.pubkey ? personProfileByPubkey.get(message.pubkey) : undefined;
      const canonicalAuthorHandle =
        message.authorIdentity?.handle ??
        (isAgent
          ? knownAgent?.handle
          : (personProfile?.handle ??
            (message.pubkey ? fallbackMemberHandle(message.pubkey) : undefined)));
      const personName = personProfile?.name;
      const attachmentPreview = message.attachments?.[0]?.name;
      return {
        // A reconciled draft/final bubble's display `id` is a synthetic
        // per-turn key. The composer separately obtains the opaque threading
        // proof from the snapshot using this real message id.
        messageId: message.relayId ?? message.id,
        authorName:
          message.authorIdentity?.name ??
          agentDisplay?.name ??
          personName ??
          fallbackMemberName(message.pubkey ?? ''),
        ...(canonicalAuthorHandle ? { authorHandle: canonicalAuthorHandle } : {}),
        ...(message.pubkey ? { authorPubkey: message.pubkey } : {}),
        isAgent,
        preview: message.text.trim() || attachmentPreview || 'Attachment',
      };
    },
    [agentByPubkey, personProfileByPubkey],
  );


  const beginReply = useCallback(
    (message: ChatDisplayMessage) => {
      const target = beginReplyTarget(
        message,
        chronologicalMessagesRef.current,
        replyTargetForMessage(message),
        decodedId,
      );
      if (!target) return;
      const install = () => {
        setReplyTarget(target);
        if (target.isAgent && target.authorHandle && target.authorPubkey) {
          applyComposerPrefill(
            planReplyPrefill({
              draft: inputTextRef.current,
              prefill: composerPrefillRef.current,
              handle: target.authorHandle,
              pubkey: target.authorPubkey,
              sourceMessageId: target.messageId,
            }),
            { handle: target.authorHandle, pubkey: target.authorPubkey },
          );
        }
        setDismissedMentionKey(null);
        void Haptics.selectionAsync();
        // A reply started from a message the reader scrolled up to read keeps
        // that same scroll offset by default while the keyboard/reply banner
        // shrink the viewport, which reads as the transcript jumping to
        // center the replied-to message. The reply reference in the composer
        // is enough context, so land back on the end of the log instead.
        scrollController.request({ kind: 'newest' });
        scheduleAnimationFrame(() => composerRef.current?.focus());
      };
      install();
    },
    // Read through the ref: a transcript dependency here would hand every
    // row a new renderer on each live message.
    [applyComposerPrefill, decodedId, replyTargetForMessage, scrollController],
  );


  const handleReactToMessage = useCallback(
    async (message: ChatDisplayMessage, emoji: MessageReactionEmoji) => {
      if (message.isAgentDraft) return;
      const messageId = message.relayId ?? message.id;
      if (reactingRef.current.has(messageId)) return;
      reactingRef.current.add(messageId);
      const previous = optimisticReactionsRef.current[messageId] ?? message.reactions ?? [];
      const existing = previous.find((reaction) => reaction.emoji === emoji);
      const next = existing
        ? previous.map((reaction) => reaction.emoji === emoji ? {
            ...reaction,
            count: Math.max(0, reaction.count + (reaction.reacted ? -1 : 1)),
            reacted: !reaction.reacted,
          } : reaction).filter((reaction) => reaction.count > 0)
        : [...previous, { emoji, count: 1, reacted: true }];
      setOptimisticReactions((current) => ({ ...current, [messageId]: next }));
      try {
        const canonical = await monolithPhoneOperation('reactToMessage', {
          roomId: decodedId,
          messageId,
          emoji,
        });
        if (canonical) {
          applyRoomMessageResult(canonical);
          if (canonical.prompt !== undefined) starPrompt.accept({ prompt: canonical.prompt });
        }
        setOptimisticReactions((current) => {
          const updated = { ...current };
          delete updated[messageId];
          return updated;
        });
      } catch (error) {
        setOptimisticReactions((current) => {
          const updated = { ...current };
          delete updated[messageId];
          return updated;
        });
        Modal.alert('Could not react', appErrorCopy(error));
      } finally {
        reactingRef.current.delete(messageId);
      }
    },
    [applyRoomMessageResult, decodedId, starPrompt.accept],
  );


  const messageIsBookmarked = useCallback(
    (message: ChatDisplayMessage) => Boolean(
      roomMessageRecord(messageRecordScope, decodedId, message.relayId ?? message.id)?.bookmarked ?? message.bookmarked,
    ),
    [decodedId, messageRecordScope],
  );


  const handleBookmarkMessage = useCallback(
    async (message: ChatDisplayMessage) => {
      if (message.isAgentActivity || message.isAgentDraft) return;
      const messageId = message.relayId ?? message.id;
      const previous = messageIsBookmarked(message);
      const bookmarked = !previous;
      writeRoomBookmark(messageRecordScope, decodedId, messageId, bookmarked);
      AccessibilityInfo.announceForAccessibility(
        bookmarked ? 'Message bookmarked' : 'Bookmark removed',
      );
      try {
        const result = await monolithPhoneOperation('setMessageBookmark', {
          roomId: decodedId,
          messageId,
          bookmarked,
        });
        writeRoomBookmark(messageRecordScope, decodedId, messageId, result.bookmarked);
        const row = roomMessageRecord(messageRecordScope, decodedId, messageId);
        if (row) applyRoomMessageResult({ ...row, bookmarked: result.bookmarked });
      } catch (error) {
        writeRoomBookmark(messageRecordScope, decodedId, messageId, previous);
        AccessibilityInfo.announceForAccessibility('Bookmark change failed');
        Modal.alert(
          bookmarked ? 'Could not bookmark message' : 'Could not remove bookmark',
          appErrorCopy(error),
        );
      }
    },
    [applyRoomMessageResult, decodedId, messageIsBookmarked, messageRecordScope],
  );


  const handleReportMessage = useCallback(
    async (message: ChatDisplayMessage) => {
      if (message.isAgentActivity || message.isAgentDraft) return;
      const messageId = message.relayId ?? message.id;
      const outcome = await promptAndReportMessageIssue(
        { roomId: decodedId, messageId },
        {
          prompt: (title, body, options) => Modal.prompt(title, body, options),
          report: (input) => monolithPhoneOperation('reportMessageIssue', input),
        },
      );
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'failed') {
        Modal.alert('Could not report message', phoneOperationFailureReason(outcome.error));
        return;
      }
      const row = roomMessageRecord(messageRecordScope, decodedId, messageId);
      if (row) applyRoomMessageResult({ ...row, feedbackReported: true });
      const copy = reportIssueToastCopy(outcome.duplicate);
      showReportToast(copy);
      AccessibilityInfo.announceForAccessibility(copy);
    },
    [applyRoomMessageResult, decodedId, messageRecordScope, showReportToast],
  );


  const canDeleteMessage = useCallback(
    (message: ChatDisplayMessage) =>
      !message.deleted &&
      !message.isAgentActivity &&
      !message.isAgentDraft &&
      (message.isUser || canManageWorkspace),
    [canManageWorkspace],
  );

  const handleDeleteMessage = useCallback(
    async (message: ChatDisplayMessage) => {
      if (!canDeleteMessage(message)) return;
      if (outbox.current()?.get(message.id)) {
        outbox.dismiss(message.id);
        AccessibilityInfo.announceForAccessibility('Message deleted');
        return;
      }
      const confirmed = await Modal.confirm(
        'Delete message?',
        'The message text and attachments will be removed. A deleted-message record will remain in this Room.',
        { cancelText: 'Cancel', confirmText: 'Delete', destructive: true },
      );
      if (!confirmed) return;
      const messageId = message.relayId ?? message.id;
      setOptimisticDeletes((current) => ({ ...current, [messageId]: true }));
      try {
        const canonical = await monolithPhoneOperation('deleteRoomMessage', {
          roomId: decodedId,
          messageId,
        });
        if (canonical) applyRoomMessageResult(canonical);
        setOptimisticDeletes((current) => {
          const updated = { ...current };
          delete updated[messageId];
          return updated;
        });
        AccessibilityInfo.announceForAccessibility('Message deleted');
      } catch (error) {
        setOptimisticDeletes((current) => {
          const updated = { ...current };
          delete updated[messageId];
          return updated;
        });
        Modal.alert(
          'Could not delete message',
          appErrorCopy(error),
        );
      }
    },
    [applyRoomMessageResult, canDeleteMessage, decodedId, outbox],
  );

  const openMessageActions = useCallback((message: ChatDisplayMessage) => {
    // A live draft is the turn still writing — it settles into the reply the
    // actions would target, so it offers none.
    if (message.isAgentDraft || message.deleted) return;
    void Haptics.selectionAsync();
    setMessageActionsTarget(message);
  }, []);


  const workspaceChatListRef = useRef(workspaceChatList);

  workspaceChatListRef.current = workspaceChatList;

  const beginForward = useCallback(
    async (message: ChatDisplayMessage) => {
      // Forward works wherever a transcript renders — the picker sheet and
      // the send operation are not desktop-bound; the guard is only the
      // message itself and the Room client.
      if (message.isAgentDraft || !roomClient || !activeCommunityId) return;
      setForwardTarget(message);
      setForwardRooms(null);
      setForwardError(null);
      try {
        // The live Room list is current; only a list not yet loaded reads one.
        const held = workspaceChatListRef.current;
        const [chats, workspace] = await Promise.all([
          held ? held.chats : chatListKey ? readChatList(chatListKey).then(list => list.chats) : Promise.reject(new Error('Room list unavailable.')),
          roomClient.workspace(activeCommunityId),
        ]);
        setForwardRooms(forwardTargets(chats, workspace, decodedId));
      } catch (error) {
        setForwardError(appErrorCopy(error));
        setForwardRooms([]);
      }
    },
    [activeCommunityId, decodedId, roomClient, chatListKey],
  );


  const forwardToRoom = useCallback(
    async (target: ForwardTarget) => {
      if (!forwardTarget || forwardBusyRoomId) return;
      setForwardBusyRoomId(target.id);
      setForwardError(null);
      try {
        if (!transport || !activeCommunityId) throw new Error('Beeline is still connecting.');
        const roomId = await resolveForwardTargetRoom(
          target,
          activeCommunityId,
          (workspaceId, memberId) => transport.resolveDirectMessage(workspaceId, memberId),
        );
        await forwardMessageToRoom(
          (input) => monolithPhoneOperation('sendRoomMessage', input),
          roomId,
          {
            text: forwardTarget.text,
            author: forwardTarget.authorIdentity ?? {
              name: forwardTarget.pubkey ? fallbackMemberName(forwardTarget.pubkey) : 'SOMEONE',
              ...(forwardTarget.pubkey
                ? { handle: fallbackMemberHandle(forwardTarget.pubkey) }
                : {}),
            },
            attachments: forwardTarget.attachments,
            source: {
              roomId: decodedId,
              messageId: forwardTarget.relayId ?? forwardTarget.id,
            },
          },
          displayRoomName,
        );
        setForwardTarget(null);
        setForwardRooms(null);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        setForwardError(appErrorCopy(error));
      } finally {
        setForwardBusyRoomId(null);
      }
    },
    [activeCommunityId, decodedId, displayRoomName, forwardBusyRoomId, forwardTarget, transport],
  );


  const dismissOutboxMessage = outbox.dismiss;
  return [
    replyTargetForMessage, beginForward, beginReply, openMessageActions, handleReactToMessage,
    handleBookmarkMessage, handleReportMessage, dismissOutboxMessage, messageIsBookmarked,
    canDeleteMessage, handleDeleteMessage, forwardToRoom,
  ];
}
