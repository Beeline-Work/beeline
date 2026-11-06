import { trackDictatedMessage } from '@/buzz/dictation-timing';
import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useRef, useCallback } from 'react';
import { Buffer } from 'buffer';
import { TextInput, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { readGitHubAccess } from '@/buzz/github-access-surface';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { publishViewerConversation, removeViewerConversation } from '@/buzz/viewer-conversation';
import { type RoomRepository } from '@beeline/buzz-client';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { yieldToNextPaint } from '@/buzz/host-scheduler';
import { RoomSendPreview } from '@/buzz/room-send-list';
import { mentionedAgentPubkey, resolveComposerMentions, selectedMentionAgentPubkey } from '@/buzz/room-participants';
import { fallbackMemberName } from '@/buzz/member-display';
import { looksLikeCornerOpenIntent, type RepoCandidate } from '@/buzz/room-repo-picker';
import { type PickedChatAttachment } from '@/buzz/chat-attachment';
import { prepareMessageReply, type MessageReplyDisplayTarget, type MessageReplyTarget } from '@/buzz/message-reply';
import { type RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';
import { type DictatedSend } from '@/components/buzz/ConversationComposer';
import { MessageShortcut, NO_SELECTED_MENTIONS, COMPOSER_MIN_HEIGHT } from './chat-surface-values';

type Props = [
  composerDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  inputTextRef: React.RefObject<string>,
  replyTarget: MessageReplyTarget | null,
  pendingAttachmentsRef: React.RefObject<PickedChatAttachment[]>,
  sendInFlightRef: React.RefObject<boolean>,
  isArchived: boolean,
  roomParticipants: RoomRosterParticipant[],
  selectedMentionsRef: React.RefObject<Map<string, string>>,
  captureUntaggedSend: (hasMentions: boolean) => (messageId: string) => void,
  selectedAgentMentionsRef: React.RefObject<Map<string, string>>,
  roomAgents: RoomRosterParticipant[],
  isCorner: boolean,
  outbox: import("@/app/(app)/beeline/chat/useRoomSurfaceSession").RoomSurfaceOutboxHandle,
  desktopTranscript: boolean,
  setReceivedSteer: React.Dispatch<React.SetStateAction<{ agentPubkey: string; turnRequestId: string; receivedAt: number; } | null>>,
  setPendingAck: React.Dispatch<React.SetStateAction<{ sentAt: number; requestId?: string; } | null>>,
  setSending: React.Dispatch<React.SetStateAction<boolean>>,
  desktopExperience: boolean,
  setDesktopDeliveryState: React.Dispatch<React.SetStateAction<"failed" | "sending" | "delivered" | null>>,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  userPubkey: string,
  sendPreview: RoomSendPreview,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  landAtOwnSend: (messageId: string) => void,
  addMessages: (incoming: readonly ChatDisplayMessage[]) => void,
  isDirectMessage: boolean,
  roomRepository: RoomRepository | null,
  roomRepositoryResolved: boolean,
  roomRepoAccessIssue: { fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null,
  setCornerOpenRepoPrompt: React.Dispatch<React.SetStateAction<boolean>>,
  activeCommunityId: string | null,
  roomRepoCandidates: RepoCandidate[],
  transport: BuzzRigTransport | null,
  githubScope: { relay: string; viewer: string; } | null,
  setSessionTransport: (transport: BuzzRigTransport) => void,
  removeOptimistic: (optimisticId: string) => void,
  attachmentUploader: { state(attachment: PickedChatAttachment): import("@/buzz/chat-attachment").ChatAttachmentUploadState | undefined; subscribe(listener: () => void): () => void; start(client: import("@beeline/buzz-client").BuzzClient, attachments: readonly PickedChatAttachment[]): void; retain(attachments: readonly PickedChatAttachment[]): void; uploadAll(client: import("@beeline/buzz-client").BuzzClient, attachments: readonly PickedChatAttachment[]): Promise<import("@beeline/buzz-client").AttachmentReference[]>; },
  decodedId: string,
  reconcileOptimistic: (optimisticId: string, eventId: string) => void,
  activeComposerDraftRef: React.RefObject<import("@/buzz/text-draft-store").TextDraft<string>>,
  composerInputRevisionRef: React.RefObject<number>,
  composerRef: React.RefObject<TextInput | null>,
  setComposerInputRevision: React.Dispatch<React.SetStateAction<number>>,
  setComposerHeight: React.Dispatch<React.SetStateAction<number>>,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  replacePendingAttachments: (update: PickedChatAttachment[] | ((current: PickedChatAttachment[]) => PickedChatAttachment[])) => void,
  setReplyTarget: React.Dispatch<React.SetStateAction<MessageReplyTarget | null>>,
  applyRoomMessageResult: (message: import("@beeline/api-contract/phone").RoomViewMessage) => void,
  applyPendingAgentCommands: (commands: NonNullable<import("@beeline/api-contract/phone").RoomView["pendingAgentCommands"]>) => void,
  activeAgentTurn: import("@beeline/api-contract/phone").RoomViewAgentTurn,
  acknowledgeReadMark: (messageId: string) => void,
  isFocused: () => boolean,
  parentChannelId: string | undefined,
  cacheViewerPubkey: string,
  cornerAgentPubkey: string | undefined,
  agentPresences: Record<string, import("@/buzz/agent-presence").RoomAgentPresence>,
  presenceNow: number,
  presenceReconnectGrace: Record<string, number>,
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  replyTargetForMessage: (message: ChatDisplayMessage) => MessageReplyDisplayTarget,
  setCornerProposalAction: React.Dispatch<React.SetStateAction<{ messageId: string; decision: "open" | "cancel"; } | null>>,
];

export function useChatComposerSend([
  composerDraft, inputTextRef, replyTarget, pendingAttachmentsRef, sendInFlightRef, isArchived,
  roomParticipants, selectedMentionsRef, captureUntaggedSend, selectedAgentMentionsRef, roomAgents,
  isCorner, outbox, desktopTranscript, setReceivedSteer, setPendingAck, setSending,
  desktopExperience, setDesktopDeliveryState, roomSurface, userPubkey, sendPreview,
  scrollController, landAtOwnSend, addMessages, isDirectMessage, roomRepository,
  roomRepositoryResolved, roomRepoAccessIssue, setCornerOpenRepoPrompt, activeCommunityId,
  roomRepoCandidates, transport, githubScope, setSessionTransport, removeOptimistic,
  attachmentUploader, decodedId, reconcileOptimistic, activeComposerDraftRef,
  composerInputRevisionRef, composerRef, setComposerInputRevision, setComposerHeight,
  setInputSelection, replacePendingAttachments, setReplyTarget, applyRoomMessageResult,
  applyPendingAgentCommands, activeAgentTurn, acknowledgeReadMark, isFocused, parentChannelId,
  cacheViewerPubkey, cornerAgentPubkey, agentPresences, presenceNow, presenceReconnectGrace,
  agentByPubkey, replyTargetForMessage, setCornerProposalAction,
]: Props): [
  handleSend: (shortcut?: MessageShortcut, dictated?: DictatedSend) => Promise<boolean | undefined>,
  handleCornerProposalDecision: (message: ChatDisplayMessage, decision: "open" | "cancel") => void,
] {

  const handleSend = useCallback(
    async (shortcut?: MessageShortcut, dictated?: DictatedSend) => {
      // A leaked responder event must never read as a shortcut (#1340's
      // `onPress={onSend}` handed the PressEvent straight in; `!shortcut` then
      // skipped the composer-clear block and the field kept its text after
      // every send). Only a real shortcut — it always carries text — qualifies.
      const sendShortcut = shortcut && typeof shortcut.text === 'string' ? shortcut : undefined;
      const clearSubmittedDraft = composerDraft.captureMessage();
      const viewer = sendShortcut?.viewer;
      const spoken = (sendShortcut?.text ?? inputTextRef.current).trim();
      const addressed = viewer?.agentHandle && !spoken.includes(`@${viewer.agentHandle}`)
        ? `@${viewer.agentHandle} ${spoken}` : spoken;
      const rawText = viewer ? `${addressed}\n\n[${viewer.context}]` : addressed;
      const activeReplyTarget = sendShortcut ? sendShortcut.replyTarget : replyTarget;
      const activePendingAttachments = viewer?.pickedAttachments ?? (sendShortcut ? [] : pendingAttachmentsRef.current);
      // State updates are committed asynchronously. A ref closes the short
      // double-tap window before `sending` can disable the native control.
      if (
        sendInFlightRef.current ||
        (!spoken && activePendingAttachments.length === 0) ||
        isArchived
      )
        return;
      const preparedReply = activeReplyTarget
        ? prepareMessageReply(rawText, activeReplyTarget)
        : undefined;
      const text = preparedReply?.text ?? rawText;
      const mentionedPubkeys = resolveComposerMentions(
        text,
        roomParticipants,
        sendShortcut ? NO_SELECTED_MENTIONS : selectedMentionsRef.current,
      ).pubkeys;
      const recordUntaggedSend = captureUntaggedSend(mentionedPubkeys.length > 0);
      const selectedMentionedAgent = sendShortcut
        ? undefined
        : selectedMentionAgentPubkey(text, selectedAgentMentionsRef.current);
      const mentionedAgent =
        selectedMentionedAgent ??
        preparedReply?.agentPubkey ??
        mentionedPubkeys.find((pubkey) => roomAgents.some((agent) => agent.pubkey === pubkey)) ??
        mentionedAgentPubkey(text, roomAgents);
      // Resolve before attachment upload or cold transport creation so the ack
      // cannot wait on either. A corner (one agent, always addressed) or a
      // two-party Room (the sole other participant may speak naturally, per the
      // addressing rule) counts too.
      const addressesAgent =
        isCorner ||
        Boolean(mentionedAgent) ||
        (roomAgents.length === 1 && roomParticipants.length <= 2);
      // Retain this Room's delivery handle across first paint and navigation.
      // Session cleanup may clear its ref while this send is still preparing.
      let activeOutbox = outbox.current();
      sendInFlightRef.current = true;
      const listPreview = !desktopTranscript && activePendingAttachments.length === 0;
      const updateSendStatus = () => {
        setReceivedSteer(null);
        setPendingAck(addressesAgent ? { sentAt: Date.now() } : null);
        setSending(true);
        if (desktopExperience) setDesktopDeliveryState('sending');
      };
      if (!listPreview) updateSendStatus();
      // Text feedback lands in the local overlay in this same turn. Signing,
      // transport startup and outbox persistence can all take longer than a
      // frame on a cold Android device.
      // Each viewport paints its provisional row before preparation.
      const provisionalId = activePendingAttachments.length === 0
        ? `pending:${Date.now()}:${Math.random()}`
        : null;
      if (provisionalId) {
        const provisional = {
          id: provisionalId,
          text,
          isUser: true,
          timestamp: Math.floor(Date.now() / 1_000),
          authorIdentity: roomSurface?.viewer.identity ?? {
            pubkey: userPubkey,
            kind: 'human',
            name: fallbackMemberName(userPubkey),
          },
          pubkey: userPubkey,
          ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
          ...(preparedReply?.reference ? { replyToId: preparedReply.reference.eventId } : {}),
        } satisfies ChatDisplayMessage;
        if (listPreview) {
          // Only the list's new cell renders now. Window resets, status and
          // the Room-wide projections wait until native layout and a frame.
          const painted = sendPreview.show(provisional);
          scrollController.request({ kind: 'newest' });
          await painted;
          updateSendStatus();
          landAtOwnSend(provisionalId);
        } else {
          addMessages([provisional]);
          landAtOwnSend(provisionalId);
          await yieldToNextPaint();
        }
      }
      // Repository guidance is optional; the agent must still receive the request.
      if (
        !isDirectMessage &&
        !isCorner &&
        ((!roomRepository && roomRepositoryResolved) || roomRepoAccessIssue) &&
        looksLikeCornerOpenIntent(rawText)
      ) {
        setCornerOpenRepoPrompt(true);
        if (activeCommunityId && roomRepoCandidates.length === 0 && transport) {
          if (githubScope) void readGitHubAccess(transport, githubScope, true)
            .catch(() => undefined);
        }
      }
      let preparedEvent: Awaited<ReturnType<BuzzRigTransport['composeMessage']>> | undefined;
      try {
        // A warm/partial snapshot can paint before the hydration effect has
        // published its transport state. Sending is still a valid operation:
        // construct the monolith transport on demand rather than
        // leaving the enabled send control as a silent no-op.
        let sendTransport = transport;
        if (!sendTransport) {
          const identity = await loadBuzzIdentity();
          if (!identity) throw new Error('Beeline identity is unavailable');
          sendTransport = new BuzzRigTransport(identity);
        }
        if (!transport) setSessionTransport(sendTransport);
        // ■ on a dictated message drops it at any step before it enters the Room.
        const dictationCancelled = () => {
          if (!dictated?.cancelled) return false;
          setPendingAck(null);
          if (provisionalId) {
            sendPreview.remove(preparedEvent?.id ?? provisionalId);
            removeOptimistic(preparedEvent?.id ?? provisionalId);
          }
          if (desktopExperience) setDesktopDeliveryState(null);
          return true;
        };
        if (dictationCancelled()) return;
        const uploadedSnapshot = viewer?.screenshotBase64
          ? await (async () => {
              const bytes = Uint8Array.from(Buffer.from(viewer.screenshotBase64!, 'base64'));
              const uploaded = await sendTransport.uploadMedia(bytes, 'image/jpeg');
              return {
                url: uploaded.url,
                name: 'browser-screen.jpg',
                mimeType: 'image/jpeg',
                size: uploaded.size,
                sha256: uploaded.sha256,
                ...(uploaded.thumb ? { thumbnailUrl: uploaded.thumb } : {}),
              };
            })()
          : undefined;
        const selectedAttachments = activePendingAttachments.length
            ? await attachmentUploader.uploadAll(await sendTransport.ensureClient(), activePendingAttachments)
            : [];
        const attachments = [
          ...(viewer?.artifact ? [viewer.artifact] : []),
          ...(uploadedSnapshot ? [uploadedSnapshot] : []),
          ...selectedAttachments,
        ];
        if (dictationCancelled()) return;
        // Sign before append. The authoritative event id is the optimistic row
        // identity and the durable outbox key from its first frame onward.
        preparedEvent = preparedReply?.reference
          ? await sendTransport.composeReplyMessage(
              text,
              preparedReply.reference,
              mentionedAgent,
              attachments,
              mentionedPubkeys,
            )
          : await sendTransport.composeMessage(
              { sessionId: decodedId, text, attachments },
              mentionedAgent || mentionedPubkeys.length
                ? {
                    ...(mentionedAgent ? { mentionAgent: mentionedAgent } : {}),
                    ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
                  }
                : undefined,
            );
        if (addressesAgent) {
          setPendingAck((current) =>
            current ? { ...current, requestId: preparedEvent!.id } : current,
          );
        }
        if (provisionalId) {
          if (listPreview) sendPreview.reconcile(provisionalId, preparedEvent.id);
          else reconcileOptimistic(provisionalId, preparedEvent.id);
        }
        const optimistic = {
          id: preparedEvent.id,
          text,
          isUser: true,
          timestamp: preparedEvent.created_at,
          authorIdentity: roomSurface?.viewer.identity ?? {
            pubkey: userPubkey,
            kind: 'human',
            name: fallbackMemberName(userPubkey),
          },
          pubkey: userPubkey,
          reference: undefined,
          ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
          ...(preparedReply?.reference ? { replyToId: preparedReply.reference.eventId } : {}),
          ...(attachments.length ? { attachments } : {}),
        } satisfies ChatDisplayMessage;
        activeOutbox ??= outbox.current();
        if (!activeOutbox) throw new Error('Message outbox is unavailable');
        if (dictationCancelled()) return;
        if (dictated) {
          trackDictatedMessage(preparedEvent.id, dictated.timing);
          dictated.committed = true;
        }
        await activeOutbox.enqueue(preparedEvent, {
          id: preparedEvent.id,
          text,
          createdAt: preparedEvent.created_at,
          author: roomSurface?.viewer.identity ?? {
            pubkey: userPubkey,
            kind: 'human',
            name: fallbackMemberName(userPubkey),
          },
          presentation: 'message',
          ...(mentionedPubkeys.length ? { mentionPubkeys: mentionedPubkeys } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
        landAtOwnSend(optimistic.id);
        if (!provisionalId) addMessages([optimistic]);
        if (!sendShortcut) {
          const draftCleared = clearSubmittedDraft();
          if (activeComposerDraftRef.current === composerDraft) {
            if (draftCleared) {
              const nextInputRevision = composerInputRevisionRef.current + 1;
              composerInputRevisionRef.current = nextInputRevision;
              // Reconcile only the remaining draft, including typing appended during send.
              if (!composerDraft.value) composerRef.current?.clear();
              inputTextRef.current = composerDraft.value;
              setComposerInputRevision(nextInputRevision);
              if (!composerDraft.value) setComposerHeight(COMPOSER_MIN_HEIGHT);
              const end = composerDraft.value.length;
              setInputSelection({ start: end, end });
            }
            replacePendingAttachments((current) =>
              current.filter((attachment) => !activePendingAttachments.includes(attachment)),
            );
            setReplyTarget((current) => (current === activeReplyTarget ? null : current));
          }
        }
        const writeResult = await activeOutbox.send(preparedEvent.id);
        if (!writeResult) {
          if (desktopExperience) setDesktopDeliveryState(null);
          return true;
        }
        recordUntaggedSend(preparedEvent.id);
        if (writeResult.message) applyRoomMessageResult(writeResult.message);
        if (writeResult.pendingAgentCommands) applyPendingAgentCommands(writeResult.pendingAgentCommands);
        if (
          isCorner &&
          activeAgentTurn &&
          writeResult.activeSteerAgentIds?.includes(activeAgentTurn.agentPubkey)
        ) {
          setReceivedSteer({
            agentPubkey: activeAgentTurn.agentPubkey,
            turnRequestId: activeAgentTurn.requestId,
            receivedAt: Date.now(),
          });
        }
        if (desktopExperience) setDesktopDeliveryState('delivered');
        // The write ack retires the local bridge: the server has STORED the
        // message, so "sending…" has nothing left to bridge. It used to outlive
        // the write by up to the whole first-token wait (tens of seconds) or
        // its own 15s bound, whichever was longer. The claimed turn's WORKING
        // receipt lights `thinking` on its own, and this ack must not sit
        // between them.
        const ackedRequestId = preparedEvent.id;
        setPendingAck((current) =>
          current && (current.requestId === undefined || current.requestId === ackedRequestId)
            ? null
            : current,
        );
        // The server moved our read mark with the send itself, so a message we
        // wrote never golds the Room list (room-list-row.ts) and the viewport
        // has no mark left to write for it. The write receipt or live delta
        // paints the canonical message without a confirmation GET.
        acknowledgeReadMark(preparedEvent.id);
        return true;
      } catch (err) {
        console.warn('Send failed:', err);
        if (listPreview && provisionalId && (!preparedEvent || !activeOutbox?.get(preparedEvent.id))) {
          sendPreview.remove(preparedEvent?.id ?? provisionalId);
        }
        if (provisionalId && !preparedEvent) {
          removeOptimistic(provisionalId);
        }
        if (desktopExperience) setDesktopDeliveryState('failed');
        // Delivery errors stay in the outbox. Preparation errors keep the draft.
        setPendingAck(null);
        if (isFocused() && (!preparedEvent || !activeOutbox?.get(preparedEvent.id))) {
          Modal.alert('Could not prepare message', appErrorCopy(err));
        }
        return false;
      } finally {
        sendInFlightRef.current = false;
        setSending(false);
      }
    },
    [
      captureUntaggedSend,
      isFocused,
      outbox,
      isDirectMessage,
      activeCommunityId,
      attachmentUploader,
      replacePendingAttachments,
      transport,
      decodedId,
      addMessages,
      reconcileOptimistic,
      removeOptimistic,
      desktopTranscript,
      sendPreview,
      scrollController,
      isArchived,
      isCorner,
      activeAgentTurn,
      userPubkey,
      parentChannelId,
      roomParticipants,
      roomAgents,
      cacheViewerPubkey,
      replyTarget,
      roomRepoCandidates.length,
      roomRepository,
      cornerAgentPubkey,
      agentPresences,
      presenceNow,
      presenceReconnectGrace,
      agentByPubkey,
      applyPendingAgentCommands,
      roomRepositoryResolved,
      roomRepoAccessIssue,
      roomSurface,
      desktopExperience,
      composerDraft,
      landAtOwnSend,
    ],
  );


  // Fill modals render outside the Room tree. Give the viewer the Room's live
  // messages and its signed/outbox-backed send path without a second socket.
  useFocusEffect(useCallback(() => {
    if (!roomSurface || !isFocused()) return;
    publishViewerConversation({
      roomId: decodedId,
      messages: roomSurface.messages,
      send: (message, dictated) => handleSend({ text: message.text, viewer: message }, dictated).then(Boolean),
    });
    return () => removeViewerConversation(decodedId);
  }, [decodedId, handleSend, isFocused, roomSurface]));


  // A row action needs the latest send state when tapped, without subscribing
  // every transcript cell to the send handler's draft and Room dependencies.
  const handleSendRef = useRef(handleSend);

  handleSendRef.current = handleSend;

  const handleCornerProposalDecision = useCallback(
    (message: ChatDisplayMessage, decision: 'open' | 'cancel') => {
      if (sendInFlightRef.current) return;
      const proposalReplyTarget = {
        ...replyTargetForMessage(message),
        ...(message.reference ? { reference: message.reference } : {}),
      };
      setCornerProposalAction({ messageId: message.id, decision });
      void handleSendRef.current({
        text: decision === 'open' ? 'go' : 'cancel',
        replyTarget: proposalReplyTarget,
      }).finally(() =>
        setCornerProposalAction((current) =>
          current?.messageId === message.id && current.decision === decision ? null : current,
        ),
      );
    },
    [replyTargetForMessage],
  );
  return [
    handleSend, handleCornerProposalDecision,
  ];
}
