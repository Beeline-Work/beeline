import React, { useCallback } from 'react';
import { TextInput } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type ChannelReferenceTarget } from '@/buzz/channel-reference';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { openExternalUrl } from '@/utils/open-external-url';
import { FAST_MODE_COMMAND, insertAgentSlashCommand, type BuiltInSlashVerbId, type FastModeCommandState } from '@/buzz/slash-verbs';
import { roomCornersHref } from '@/buzz/corner-navigation';
import { copyEntireTurn } from '@/buzz/message-copy';
import { storeTempText } from '@/sync/persistence';
import { useScopedCallbacks } from '@/buzz/use-stable';
import { type DictatedSend } from '@/components/buzz/ConversationComposer';
import { MessageShortcut, COMPOSER_MIN_HEIGHT } from './chat-surface-values';

type Props = [
  inputTextRef: React.RefObject<string>,
  setInputText: (update: string | ((previous: string) => string)) => void,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  setComposerHeight: React.Dispatch<React.SetStateAction<number>>,
  setDismissedSlashText: React.Dispatch<React.SetStateAction<string | null>>,
  setHighlightedSlashVerbIndex: React.Dispatch<React.SetStateAction<number>>,
  composerRef: React.RefObject<TextInput | null>,
  inputText: string,
  mentionSlashAgentPubkey: string | null,
  mentionAgentCommandScope: string | null,
  agentFastModeByScope: Record<string, FastModeCommandState | null>,
  activeCommunityId: string | null,
  setAgentFastModeByScope: React.Dispatch<React.SetStateAction<Record<string, FastModeCommandState | null>>>,
  transport: BuzzRigTransport | null,
  setSessionTransport: (transport: BuzzRigTransport) => void,
  decodedId: string,
  setCreatePollVisible: React.Dispatch<React.SetStateAction<boolean>>,
  canManageWorkspace: boolean,
  pendingCornerRequest: ChatDisplayMessage | undefined,
  handleWritePermission: (message: ChatDisplayMessage, decision: "allow" | "deny") => Promise<void>,
  startRenameFromTitle: () => void,
  handleCloseCorner: () => Promise<void>,
  pendingTargetBranchProposal: ChatDisplayMessage | undefined,
  handleConfirmTargetBranch: (message: ChatDisplayMessage) => Promise<void>,
  handleConnectAgent: () => void,
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>,
  setParticipantPickerKind: React.Dispatch<React.SetStateAction<"agent" | "person" | null>>,
  openWorkspaceRoster: () => void,
  setParticipantPickerVisible: React.Dispatch<React.SetStateAction<boolean>>,
  highlightedSlashVerbIndex: number,
  mentionAgentCommands: import("@/buzz/slash-verbs").AgentPaletteCommand[],
  slashVerbs: import("@/buzz/slash-verbs").BuiltInSlashVerb[],
  handleSend: (shortcut?: MessageShortcut, dictated?: DictatedSend) => Promise<boolean | undefined>,
  beginForward: (message: ChatDisplayMessage) => Promise<void>,
  handleForwardToNewCorner: (message: ChatDisplayMessage) => void,
  handleOpenChannelReference: (target: ChannelReferenceTarget, text?: string) => Promise<void>,
  handleOpenMention: (participantId: string) => Promise<void>,
  cacheViewerPubkey: string,
];

export function useChatComposerCommands([
  inputTextRef, setInputText, setInputSelection, setComposerHeight, setDismissedSlashText,
  setHighlightedSlashVerbIndex, composerRef, inputText, mentionSlashAgentPubkey,
  mentionAgentCommandScope, agentFastModeByScope, activeCommunityId, setAgentFastModeByScope,
  transport, setSessionTransport, decodedId, setCreatePollVisible, canManageWorkspace,
  pendingCornerRequest, handleWritePermission, startRenameFromTitle, handleCloseCorner,
  pendingTargetBranchProposal, handleConfirmTargetBranch, handleConnectAgent, setMembershipError,
  setParticipantPickerKind, openWorkspaceRoster, setParticipantPickerVisible,
  highlightedSlashVerbIndex, mentionAgentCommands, slashVerbs, handleSend, beginForward,
  handleForwardToNewCorner, handleOpenChannelReference, handleOpenMention, cacheViewerPubkey,
]: Props): [
  rowActions: { handleWritePermission: (message: ChatDisplayMessage, decision: "allow" | "deny") => Promise<void>; beginForward: (message: ChatDisplayMessage) => Promise<void>; handleForwardToNewCorner: (message: ChatDisplayMessage) => void; handleConfirmTargetBranch: (message: ChatDisplayMessage) => Promise<void>; handleOpenChannelReference: (target: ChannelReferenceTarget, text?: string) => Promise<void>; handleOpenMention: (participantId: string) => Promise<void>; },
  handleOpenGitHubEvent: (url: string) => void,
  handleOpenSystemIdentity: () => void,
  handleCopyLedgerMessage: (text: string) => void,
  dismissSlashMenu: () => void,
  runSlashVerb: (verb: BuiltInSlashVerbId) => void,
  selectAgentCommand: (name: string) => void,
  selectHighlightedPaletteItem: () => void,
  handleSelectLedgerMessage: (text: string) => void,
] {


  const clearSlashComposer = useCallback(() => {
    inputTextRef.current = '';
    setInputText('');
    setInputSelection({ start: 0, end: 0 });
    setComposerHeight(COMPOSER_MIN_HEIGHT);
    setDismissedSlashText(null);
    setHighlightedSlashVerbIndex(0);
    scheduleAnimationFrame(() => composerRef.current?.focus());
  }, []);


  const dismissSlashMenu = useCallback(() => {
    clearSlashComposer();
    void Haptics.selectionAsync();
  }, [clearSlashComposer]);


  /**
   * Insert a selected agent command in place of the typed `/query` token,
   * KEEPING the @mention that scoped the palette. The trailing space closes
   * the palette and leaves the composer ready for the command's arguments.
   */
  const insertAgentCommand = useCallback(
    (name: string) => {
      const next = insertAgentSlashCommand(inputText, name);
      inputTextRef.current = next;
      setInputText(next);
      setInputSelection({ start: next.length, end: next.length });
      setComposerHeight(COMPOSER_MIN_HEIGHT);
      void Haptics.selectionAsync();
    },
    [inputText],
  );


  /**
   * Fast mode is the owner's toggle, not text: it writes through the same
   * `updateAgentModelSelection` operation as the profile switch and leaves
   * the palette open on the new state.
   */
  const toggleAgentFastMode = useCallback(async () => {
    const pubkey = mentionSlashAgentPubkey;
    const scope = mentionAgentCommandScope;
    const current = scope ? agentFastModeByScope[scope] : null;
    if (!pubkey || !scope || !current || current.status === 'saving' || !activeCommunityId) {
      return;
    }
    const enabled = !current.enabled;
    setAgentFastModeByScope((state) => ({
      ...state,
      [scope]: { enabled: current.enabled, status: 'saving' },
    }));
    void Haptics.selectionAsync();
    try {
      let writeTransport = transport;
      if (!writeTransport) {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Beeline identity is unavailable');
        writeTransport = new BuzzRigTransport(identity);
        setSessionTransport(writeTransport);
      }
      const client = await writeTransport.ensureClient();
      await client.setAgentModelConfig(activeCommunityId, pubkey, { fastMode: enabled });
      setAgentFastModeByScope((state) => ({ ...state, [scope]: { enabled } }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setAgentFastModeByScope((state) => ({
        ...state,
        [scope]: { enabled: current.enabled, status: 'failed' },
      }));
    }
  }, [
    activeCommunityId,
    agentFastModeByScope,
    mentionAgentCommandScope,
    mentionSlashAgentPubkey,
    setSessionTransport,
    transport,
  ]);


  const selectAgentCommand = useCallback(
    (name: string) => {
      if (name === FAST_MODE_COMMAND) {
        void toggleAgentFastMode();
        return;
      }
      insertAgentCommand(name);
    },
    [insertAgentCommand, toggleAgentFastMode],
  );


  const runSlashVerb = useCallback(
    (verb: BuiltInSlashVerbId) => {
      clearSlashComposer();
      void Haptics.selectionAsync();
      switch (verb) {
        case 'build':
          router.push(roomCornersHref(decodedId));
          return;
        case 'poll':
          setCreatePollVisible(true);
          return;
        case 'schedule':
          if (!canManageWorkspace || !activeCommunityId) return;
          router.push({
            pathname: '/beeline/settings/schedules',
            params: { roomId: decodedId, workspaceId: activeCommunityId },
          } as unknown as Href);
          return;
        case 'workflow':
          if (!canManageWorkspace) return;
          router.push({
            pathname: '/beeline/settings/workflows',
            params: { roomId: decodedId },
          } as unknown as Href);
          return;
        case 'open-corner':
          if (pendingCornerRequest) void handleWritePermission(pendingCornerRequest, 'allow');
          return;
        case 'rename':
          startRenameFromTitle();
          return;
        case 'close-corner':
          void handleCloseCorner();
          return;
        case 'change-target-branch':
          if (pendingTargetBranchProposal) {
            void handleConfirmTargetBranch(pendingTargetBranchProposal);
          }
          return;
        case 'add-agent':
          if (!canManageWorkspace) {
            handleConnectAgent();
            return;
          }
          setMembershipError(null);
          setParticipantPickerKind('agent');
          openWorkspaceRoster();setParticipantPickerVisible(true);
          return;
        case 'invite':
          if (!canManageWorkspace) return;
          setMembershipError(null);
          setParticipantPickerKind('person');
          openWorkspaceRoster();setParticipantPickerVisible(true);
      }
    },
    [
      clearSlashComposer,
      openWorkspaceRoster,
      activeCommunityId,
      canManageWorkspace,
      decodedId,
      handleCloseCorner,
      handleConnectAgent,
      handleConfirmTargetBranch,
      handleWritePermission,
      pendingCornerRequest,
      pendingTargetBranchProposal,
      startRenameFromTitle,
    ],
  );


  /** Select whatever the highlight points at across commands-then-verbs. */
  const selectHighlightedPaletteItem = useCallback(() => {
    const commandIndex = highlightedSlashVerbIndex - mentionAgentCommands.length;
    if (commandIndex < 0) {
      const command = mentionAgentCommands[highlightedSlashVerbIndex];
      if (command) {
        selectAgentCommand(command.name);
        return;
      }
    } else {
      const verb = slashVerbs[commandIndex];
      if (verb) {
        runSlashVerb(verb.id);
        return;
      }
    }
    // No match at all: Enter/the send button passes the text through as an
    // ordinary message instead of dying as a dead end. The daemon visibly
    // marks such text on the other side.
    handleSend();
  }, [
    handleSend,
    highlightedSlashVerbIndex,
    selectAgentCommand,
    inputText,
    mentionAgentCommands,
    runSlashVerb,
    slashVerbs,
  ]);


  const handleOpenGitHubEvent = useCallback((url: string) => {
    void openExternalUrl(url).catch(() => undefined);
  }, []);

  // A name in a system line opens the roster, where that identity lives.
  const handleOpenSystemIdentity = useCallback(() => {
    router.push({
      pathname: '/beeline/members',
      params: activeCommunityId ? { communityId: activeCommunityId } : {},
    } as Href);
  }, [activeCommunityId]);

  const handleCopyLedgerMessage = useCallback((text: string) => {
    void copyEntireTurn(text, Clipboard.setStringAsync);
  }, []);

  const handleSelectLedgerMessage = useCallback((text: string) => {
    const textId = storeTempText(text);
    router.push({ pathname: '/text-selection', params: { textId } } as Href);
  }, []);

  const rowActions = useScopedCallbacks({
    handleWritePermission,
    beginForward,
    handleForwardToNewCorner,
    handleConfirmTargetBranch,
    handleOpenChannelReference,
    handleOpenMention
  }, `${decodedId}\0${cacheViewerPubkey}`);
  return [
    rowActions, handleOpenGitHubEvent, handleOpenSystemIdentity, handleCopyLedgerMessage,
    dismissSlashMenu, runSlashVerb, selectAgentCommand, selectHighlightedPaletteItem,
    handleSelectLedgerMessage,
  ];
}
