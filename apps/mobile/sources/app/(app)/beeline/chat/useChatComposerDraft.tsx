import { setDesktopPaneOpen } from '@/buzz/desktop-layout-state';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { BuzzRigTransport } from '@/sync/transport';
import { type AgentComposerCommand } from '@beeline/api-contract/phone';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { desktopWorkPaneVisibleContent, initialDesktopWorkPaneState, desktopDraftKey } from '@/buzz/desktop-workbench-state';
import { createChatAttachmentUploader, type PickedChatAttachment } from '@/buzz/chat-attachment';
import { type FastModeCommandState } from '@/buzz/slash-verbs';
import { type MessageReplyTarget } from '@/buzz/message-reply';
import { useCopiedToast } from '@/components/buzz/CopiedToast';
import { type ForwardTarget } from '@/buzz/message-forward';
import { COMPOSER_MIN_HEIGHT } from './chat-surface-values';

type Props = [
  decodedId: string,
  userPubkey: string,
  desktopExperience: boolean,
  desktopAvailableWidth: number,
  outbox: import("@/app/(app)/beeline/chat/useRoomSurfaceSession").RoomSurfaceOutboxHandle,
  transport: BuzzRigTransport | null,
];

export function useChatComposerDraft([
  decodedId, userPubkey, desktopExperience, desktopAvailableWidth, outbox, transport,
]: Props): [
  inputText: string,
  setDesktopDeliveryState: React.Dispatch<React.SetStateAction<"failed" | "sending" | "delivered" | null>>,
  setInputText: (update: string | ((previous: string) => string)) => void,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  setDismissedMentionKey: React.Dispatch<React.SetStateAction<string | null>>,
  desktopWorkPaneRef: React.RefObject<import("@/buzz/desktop-workbench-state").DesktopWorkPaneState>,
  setDesktopWorkPane: React.Dispatch<React.SetStateAction<import("@/buzz/desktop-workbench-state").DesktopWorkPaneState>>,
  desktopWorkPaneContent: import("@/buzz/desktop-workbench-state").DesktopWorkPaneContent | null,
  inputSelection: { start: number; end: number; },
  dismissedMentionKey: string | null,
  agentCommandsByScope: Record<string, readonly AgentComposerCommand[]>,
  agentFastModeByScope: Record<string, FastModeCommandState | null>,
  agentCanLoginByScope: Record<string, boolean>,
  setAgentCommandsByScope: React.Dispatch<React.SetStateAction<Record<string, readonly AgentComposerCommand[]>>>,
  setAgentCanLoginByScope: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  setAgentFastModeByScope: React.Dispatch<React.SetStateAction<Record<string, FastModeCommandState | null>>>,
  optimisticDeletes: Record<string, true>,
  optimisticReactions: Record<string, readonly import("@beeline/api-contract/phone").MessageReactionView[] | undefined>,
  dismissedSlashText: string | null,
  setHighlightedSlashVerbIndex: React.Dispatch<React.SetStateAction<number>>,
  composerHeight: number,
  setReplyTarget: React.Dispatch<React.SetStateAction<MessageReplyTarget | null>>,
  reactingRef: React.RefObject<Set<string>>,
  optimisticReactionsRef: React.RefObject<Record<string, readonly import("@beeline/api-contract/phone").MessageReactionView[] | undefined>>,
  setOptimisticReactions: React.Dispatch<React.SetStateAction<Record<string, readonly import("@beeline/api-contract/phone").MessageReactionView[] | undefined>>>,
  showReportToast: (message: string) => void,
  setOptimisticDeletes: React.Dispatch<React.SetStateAction<Record<string, true>>>,
  setMessageActionsTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>,
  setForwardTarget: React.Dispatch<React.SetStateAction<ChatDisplayMessage | null>>,
  setForwardRooms: React.Dispatch<React.SetStateAction<readonly ForwardTarget[] | null>>,
  setForwardError: React.Dispatch<React.SetStateAction<string | null>>,
  forwardTarget: ChatDisplayMessage | null,
  forwardBusyRoomId: string | null,
  setForwardBusyRoomId: React.Dispatch<React.SetStateAction<string | null>>,
  composerDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  replyTarget: MessageReplyTarget | null,
  pendingAttachmentsRef: React.RefObject<PickedChatAttachment[]>,
  setSending: React.Dispatch<React.SetStateAction<boolean>>,
  attachmentUploader: { state(attachment: PickedChatAttachment): import("@/buzz/chat-attachment").ChatAttachmentUploadState | undefined; subscribe(listener: () => void): () => void; start(client: import("@beeline/buzz-client").BuzzClient, attachments: readonly PickedChatAttachment[]): void; retain(attachments: readonly PickedChatAttachment[]): void; uploadAll(client: import("@beeline/buzz-client").BuzzClient, attachments: readonly PickedChatAttachment[]): Promise<import("@beeline/buzz-client").AttachmentReference[]>; },
  activeComposerDraftRef: React.RefObject<import("@/buzz/text-draft-store").TextDraft<string>>,
  setComposerInputRevision: React.Dispatch<React.SetStateAction<number>>,
  setComposerHeight: React.Dispatch<React.SetStateAction<number>>,
  replacePendingAttachments: (update: PickedChatAttachment[] | ((current: PickedChatAttachment[]) => PickedChatAttachment[])) => void,
  setCornerProposalAction: React.Dispatch<React.SetStateAction<{ messageId: string; decision: "open" | "cancel"; } | null>>,
  pendingAttachments: PickedChatAttachment[],
  setAttachmentPickerVisible: React.Dispatch<React.SetStateAction<boolean>>,
  setHighlightedMentionIndex: React.Dispatch<React.SetStateAction<number>>,
  addingMembers: boolean,
  setAddingMembers: React.Dispatch<React.SetStateAction<boolean>>,
  setRoomRepoListLoading: React.Dispatch<React.SetStateAction<boolean>>,
  setRoomRepoError: React.Dispatch<React.SetStateAction<string | null>>,
  setShowRoomRepoPicker: React.Dispatch<React.SetStateAction<boolean>>,
  setRoomRepoNotice: React.Dispatch<React.SetStateAction<string | null>>,
  roomRepoBusy: boolean,
  setRoomRepoBusy: React.Dispatch<React.SetStateAction<boolean>>,
  roomRepoListLoading: boolean,
  roomRepoError: string | null,
  roomRepoNotice: string | null,
  showRoomRepoPicker: boolean,
  sending: boolean,
  setDismissedSlashText: React.Dispatch<React.SetStateAction<string | null>>,
  highlightedSlashVerbIndex: number,
  failedOutboxIds: ReadonlySet<string>,
  cornerProposalAction: { messageId: string; decision: "open" | "cancel"; } | null,
  turnChromeTopInset: number,
  setTurnChromeTopInset: React.Dispatch<React.SetStateAction<number>>,
  highlightedMentionIndex: number,
  desktopDeliveryState: "failed" | "sending" | "delivered" | null,
  composerInputRevision: number,
  reportToast: React.ReactNode,
  attachmentPickerVisible: boolean,
  messageActionsTarget: ChatDisplayMessage | null,
  forwardError: string | null,
  forwardRooms: readonly ForwardTarget[] | null,
] {

  const [inputText, setInputText, composerDraft] = useTextDraft(
    `composer:${decodedId}`,
    '',
    userPubkey || null,
    desktopExperience ? desktopDraftKey(decodedId) : undefined,
  );

  const activeComposerDraftRef = useRef(composerDraft);

  activeComposerDraftRef.current = composerDraft;

  const [composerInputRevision, setComposerInputRevision] = useState(0);

  const initialWorkPaneStateRef = useRef(initialDesktopWorkPaneState(desktopAvailableWidth));

  const [desktopWorkPane, setDesktopWorkPane] = useState(initialWorkPaneStateRef.current);

  const desktopWorkPaneRef = useRef(desktopWorkPane);

  const desktopWorkPaneContent = desktopWorkPaneVisibleContent(desktopWorkPane);

  useEffect(() => {
    setDesktopPaneOpen(Boolean(desktopExperience && desktopWorkPaneContent));
    return () => setDesktopPaneOpen(false);
  }, [desktopExperience, Boolean(desktopWorkPaneContent)]);

  const [desktopDeliveryState, setDesktopDeliveryState] = useState<
    'sending' | 'delivered' | 'failed' | null
  >(null);

  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);

  const [turnChromeTopInset, setTurnChromeTopInset] = useState(0);

  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);

  const [inputSelection, setInputSelection] = useState({ start: 0, end: 0 });

  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);

  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);

  const [highlightedSlashVerbIndex, setHighlightedSlashVerbIndex] = useState(0);

  const [dismissedSlashText, setDismissedSlashText] = useState<string | null>(null);

  /** Per-Room+agent command lists (undefined = unresolved, empty = advertises none). */
  const [agentCommandsByScope, setAgentCommandsByScope] = useState<
    Record<string, readonly AgentComposerCommand[]>
  >({});

  /** Per-Room+agent Fast mode toggle (undefined = unread, null = not offered to this viewer). */
  const [agentFastModeByScope, setAgentFastModeByScope] = useState<
    Record<string, FastModeCommandState | null>
  >({});

  const [agentCanLoginByScope, setAgentCanLoginByScope] = useState<Record<string, boolean>>({});

  const [sending, setSending] = useState(false);

  const [cornerProposalAction, setCornerProposalAction] = useState<{
    messageId: string;
    decision: 'open' | 'cancel';
  } | null>(null);

  const failedOutboxIds = outbox.failedIds;

  const [pendingAttachments, setPendingAttachments] = useState<PickedChatAttachment[]>([]);

  // Paste/drop and Enter can land in one browser event batch. Keep the staged
  // files current synchronously so dispatch does not read the previous render
  // and then clear a screenshot it never uploaded.
  const pendingAttachmentsRef = useRef<PickedChatAttachment[]>([]);

  const replacePendingAttachments = useCallback(
    (
      update:
        PickedChatAttachment[] | ((current: PickedChatAttachment[]) => PickedChatAttachment[]),
    ) => {
      const next = typeof update === 'function' ? update(pendingAttachmentsRef.current) : update;
      pendingAttachmentsRef.current = next;
      setPendingAttachments(next);
    },
    [],
  );

  // Staged photos and files start uploading as soon as they land in the
  // composer, so send only waits for whatever is still in flight.
  const [attachmentUploader] = useState(createChatAttachmentUploader);

  // Each row shows its own upload state, so redraw whenever one changes.
  const [, setAttachmentUploadRevision] = useState(0);

  useEffect(
    () =>
      attachmentUploader.subscribe(() => setAttachmentUploadRevision((revision) => revision + 1)),
    [attachmentUploader],
  );

  useEffect(() => {
    attachmentUploader.retain(pendingAttachments);
    if (!transport || pendingAttachments.length === 0) return;
    void transport
      .ensureClient()
      .then((client) =>
        attachmentUploader.start(
          client,
          pendingAttachments.filter((attachment) =>
            pendingAttachmentsRef.current.includes(attachment),
          ),
        ),
      )
      .catch(() => undefined);
  }, [attachmentUploader, pendingAttachments, transport]);

  const [attachmentPickerVisible, setAttachmentPickerVisible] = useState(false);

  const [messageActionsTarget, setMessageActionsTarget] = useState<ChatDisplayMessage | null>(null);

  const [optimisticReactions, setOptimisticReactions] = useState<Record<string, ChatDisplayMessage['reactions']>>({});

  const optimisticReactionsRef = useRef(optimisticReactions);

  optimisticReactionsRef.current = optimisticReactions;

  const [optimisticDeletes, setOptimisticDeletes] = useState<Record<string, true>>({});

  const reactingRef = useRef(new Set<string>());

  const { showCopied: showReportToast, toast: reportToast } =
    useCopiedToast('message-report-toast');

  const [forwardTarget, setForwardTarget] = useState<ChatDisplayMessage | null>(null);

  const [forwardRooms, setForwardRooms] = useState<readonly ForwardTarget[] | null>(null);

  const [forwardBusyRoomId, setForwardBusyRoomId] = useState<string | null>(null);

  const [forwardError, setForwardError] = useState<string | null>(null);

  // What this corner inherited from the Room it was opened out of: the task
  // the daemon recorded on its create event, and the bounded window of Room
  // conversation that preceded it. Corner-only; a Room never reads it.
  const [addingMembers, setAddingMembers] = useState(false);

  // The repo this Room owns, or `null` for a chat-only Room. Corners never
  // read this — a corner has no room-repository binding of its own; the
  // daemon resolves its working repo from its parent Room instead.
  const [showRoomRepoPicker, setShowRoomRepoPicker] = useState(false);

  const [roomRepoBusy, setRoomRepoBusy] = useState(false);

  const [roomRepoListLoading, setRoomRepoListLoading] = useState(false);

  const [roomRepoError, setRoomRepoError] = useState<string | null>(null);

  const [roomRepoNotice, setRoomRepoNotice] = useState<string | null>(null);
  return [
    inputText, setDesktopDeliveryState, setInputText, setInputSelection, setDismissedMentionKey,
    desktopWorkPaneRef, setDesktopWorkPane, desktopWorkPaneContent, inputSelection,
    dismissedMentionKey, agentCommandsByScope, agentFastModeByScope, agentCanLoginByScope,
    setAgentCommandsByScope, setAgentCanLoginByScope, setAgentFastModeByScope, optimisticDeletes,
    optimisticReactions, dismissedSlashText, setHighlightedSlashVerbIndex, composerHeight,
    setReplyTarget, reactingRef, optimisticReactionsRef, setOptimisticReactions, showReportToast,
    setOptimisticDeletes, setMessageActionsTarget, setForwardTarget, setForwardRooms,
    setForwardError, forwardTarget, forwardBusyRoomId, setForwardBusyRoomId, composerDraft,
    replyTarget, pendingAttachmentsRef, setSending, attachmentUploader, activeComposerDraftRef,
    setComposerInputRevision, setComposerHeight, replacePendingAttachments, setCornerProposalAction,
    pendingAttachments, setAttachmentPickerVisible, setHighlightedMentionIndex, addingMembers,
    setAddingMembers, setRoomRepoListLoading, setRoomRepoError, setShowRoomRepoPicker,
    setRoomRepoNotice, roomRepoBusy, setRoomRepoBusy, roomRepoListLoading, roomRepoError,
    roomRepoNotice, showRoomRepoPicker, sending, setDismissedSlashText, highlightedSlashVerbIndex,
    failedOutboxIds, cornerProposalAction, turnChromeTopInset, setTurnChromeTopInset,
    highlightedMentionIndex, desktopDeliveryState, composerInputRevision, reportToast,
    attachmentPickerVisible, messageActionsTarget, forwardError, forwardRooms,
  ];
}
