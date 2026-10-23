import { LedgerUntaggedHint } from '@/components/buzz/Ledger';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
export { GitHubEventCard, DaemonFactCard } from '@/components/buzz/LifecycleCard';
import { NotificationLifecycleCard } from '@/components/buzz/PrLifecycleCard';
export { NotificationLifecycleCard };
import { Swipeable } from 'react-native-gesture-handler';
import { DesktopMessageAction } from '@/components/buzz/DesktopMessageAction';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  MESSAGE_REACTION_EMOJIS,
  type AttachmentReference,
  type MessageReactionEmoji,
} from '@beeline/buzz-client';
import {
  CHOICE_NOTE_MAX_LENGTH,
  formatChoiceClock,
} from '@beeline/api-contract/phone';

import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import { agentActivityReplyExcerpt, canBeginReply, type MessageReplyDisplayTarget } from '@/buzz/message-reply';
import { resolveAgentDisplayIdentity, resolvePendingAgentDisplay } from '@/buzz/agent-display';
import { fallbackMemberName } from '@/buzz/member-display';
import { displayModel } from '@/buzz/model-display';
import { CHANNEL_MENTION_HANDLE, SYSTEM_MENTION_HANDLE, hasChannelMentionToken } from '@/buzz/room-participants';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import { emojiTextStyle } from '@/buzz/emoji-text';
import {
  connectorOfferConnectingLine,
  connectorOfferWaitingLine,
} from '@/buzz/connector-offer-copy';
import { AppMark } from '@/components/buzz/AppMark';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';
import { appBoardColors } from '@/buzz/app-board-style';
import { shouldShowReplyReference } from '@/buzz/reply-reference';
import {
  draftRequestId,
  provisionalDraftKey,
  rememberProvisionalDraft,
  takeProvisionalDraft,
} from '@/buzz/draft-settle';
import { liveDraftDrainStore } from '@/buzz/live-draft-drain';
import { splitLedgerText } from '@/buzz/ledger-text';
import { currentViewerConversation, subscribeViewerConversation, viewerContextLabel, splitViewerContext } from '@/buzz/viewer-conversation';
import { parseConnectorReceipt, type ConnectorReceipt } from '@/buzz/connector-receipt';
import { ledgerStamp } from '@/buzz/relative-time';
import { isLedgerDayOpener } from '@/buzz/message-dates';
import { useTranscriptStamp } from '@/buzz/use-transcript-stamp';
import { attachmentOpenUrl, formatAttachmentSize } from '@/buzz/chat-attachment';
import { artifactFormat } from '@/buzz/artifact';
import { TranscriptReference } from '@/components/buzz/TranscriptReference';
import { openComputerSessionViewer } from '@/components/buzz/ComputerSession';
import { ArtifactCard, openArtifactViewer } from '@/components/buzz/ArtifactCard';
import { ArtifactViewerScreen } from '@/components/buzz/ArtifactViewer';
import { showPictureActions } from '@/buzz/picture-actions';
import { ROOM_LABEL, CORNER_LABEL } from '@/buzz/vocabulary';
import { CornerGlyph } from '@/components/buzz/CornerGlyph';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { monolithSession } from '@/auth/monolith-session';
import { squireApprovalAction } from '@beeline/api-contract/phone';
import { AgentApprovalCard, approvalAudience, approvalDecisionNote } from '@/components/buzz/AgentApprovalCard';
import { openExternalUrl } from '@/utils/open-external-url';
import { ActivityTimeline, TurnStepsLine } from '@/components/buzz/ActivityTimeline';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { MessageReactionRoster } from '@/components/buzz/MessageReactionRoster';
import { ALIVE_RING_PAD } from '@/buzz/identity-mark';
import { parseCornerProposal } from '@/buzz/corner-proposal';
import {
  LedgerEntry,
  LedgerGhostLine,
  LedgerSystemLine,
  LedgerSteer,
  type LedgerByline,
} from '@/components/buzz/Ledger';
import { Button } from '@/components/buzz/Button';
import { NewMessageMaterialize } from '@/components/buzz/MonoHull';
import {
  TranscriptCard,
  TranscriptCardHandle,
  type TranscriptCardAction,
  type TranscriptCardChoice,
} from '@/components/buzz/TranscriptCard';
import { forwardedMessageParts } from '@/buzz/message-forward';
import { agentMessageJsonMarkdown } from '@/buzz/agent-message-json';

type WriteDecision = 'allow' | 'deny';

function cardMeta(text: string): React.ReactNode {
  return text.split(/(@[a-z0-9_-]+)/gi).map((part, index) =>
    part.startsWith('@') ? (
      <TranscriptCardHandle key={`${part}-${index}`} meta>
        {part}
      </TranscriptCardHandle>
    ) : (
      part
    ),
  );
}

export interface WritePermissionCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  /** The server's Workspace owner/admin decision (`viewer.permissions.manage`). */
  viewerCanManage?: boolean;
  actionId: string | null;
  targetBranch?: string;
  roomName?: string;
  onDecision(message: ChatDisplayMessage, decision: WriteDecision): void;
  onOpenCorner(cornerId: string): void;
}

export const WritePermissionCard = React.memo(function WritePermissionCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerCanManage = false,
  actionId,
  targetBranch,
  roomName,
  onDecision,
  onOpenCorner,
}: WritePermissionCardProps) {
  const permission = message.writePermission!;
  const squireSpending = permission.purpose === 'squire-spending';
  const display = resolveAgentDisplayIdentity(permission.agentPubkey, agent);
  const pending = permission.status === 'pending';
  const busy = actionId === permission.permissionId;
  // Squire spending is the spending agent's owner's call alone (the server
  // names them on the card); other write requests go to the requester or a
  // Workspace owner or admin, the same rule `decidePermission` enforces.
  const canDecide =
    !viewerIsAgent &&
    (squireSpending
      ? Boolean(permission.ownerPubkey) && viewerPubkey === permission.ownerPubkey
      : viewerPubkey === permission.requesterPubkey || viewerCanManage);
  const footerNote = pending
    ? !permission.repository ? 'missing target' : !canDecide ? squireSpending ? 'waiting for its owner' : 'waiting for the requester or a workspace admin' : undefined
    : approvalDecisionNote(permission.status, permission.decider, permission.decidedAt ?? message.timestamp, viewerPubkey);
  const actions: TranscriptCardAction[] =
    pending && canDecide && permission.repository
      ? [
          {
            label: 'No',
            secondary: true,
            disabled: busy,
            onPress: () => onDecision(message, 'deny'),
            testID: 'write-permission-deny',
          },
          {
            label: squireSpending ? 'Allow once' : 'Allow',
            primary: true,
            disabled: busy,
            loading: busy,
            onPress: () => onDecision(message, 'allow'),
            testID: 'write-permission-allow',
          },
        ]
      : !pending && permission.status === 'allowed' && permission.subchannelId
        ? [
            {
              label: 'Open →',
              primary: true,
              accessibilityRole: 'link',
              onPress: () => onOpenCorner(permission.subchannelId!),
              testID: 'write-permission-open-corner',
            },
          ]
        : [];
  return (
    <AgentApprovalCard
      tier={pending ? 'ask' : 'record'} testID={`write-permission-${permission.status}`} wrapTitle
      askingAgent={{ pubkey: permission.agentPubkey, kind: 'agent', name: display.name }} agent={agent}
      title={<><TranscriptCardHandle>@{display.name.replace(/^@/, '')}</TranscriptCardHandle>{' '}{squireSpending ? 'wants to spend with Trusty Squire' : 'wants to open an edit corner'}</>}
      subline={`${squireSpending ? roomName ? `#${roomName}` : 'Room' : permission.repository ?? 'Repository'} · ${approvalAudience(permission.requester, viewerPubkey)}`}
      stamp={ledgerStamp(message.timestamp)} body={permission.reason}
      facts={squireSpending ? [{ label: 'Uses', value: permission.tool }, { label: 'Can', value: 'Pay with a saved card at checkout' }]
        : [{ label: 'Repository', value: permission.repository ?? 'Missing target' }, { label: 'Branch from', value: targetBranch ?? 'main' }, { label: 'Can', value: 'Push to its own branch · merge still needs you' }]}
      footerNote={footerNote} decisionNote={!pending}
      footerNoteTestID={pending && permission.repository && !canDecide ? 'corner-approval-audience-wait' : undefined}
      footerNoteTone={permission.status === 'failed' || (pending && !permission.repository) ? 'failed' : 'quiet'}
      actions={actions}
    />
  );
});

export { GrantRequestCard, type GrantDecision, type GrantRequestCardProps } from '@/components/buzz/GrantRequestCard';

export interface SquireApprovalCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerPubkey?: string;
  onOpenSource?(roomId: string, messageId: string): void;
}

/**
 * A notification, not an authority surface: the primary action opens the
 * exact page Squire returned, where Squire's own passkey policy decides it.
 */
export const SquireApprovalCard = React.memo(function SquireApprovalCard({
  message, agent, viewerPubkey, onOpenSource,
}: SquireApprovalCardProps) {
  const approval = message.squireApproval!;
  const display = resolveAgentDisplayIdentity(approval.agent.pubkey, agent);
  const name = agent ? display.name : approval.agent.name;
  const settled = Boolean(approval.status);
  const reference = approval.reference ?? approval.detail.match(/vault:\/\/[^\s·]+/)?.[0];
  const parts = approval.detail.split(' · ');
  const facts = approval.facts ?? (approval.tool === 'inject_card'
    ? [{ label: 'From', value: parts[1]?.replace(/^at /, '') || 'Checkout' }, ...(parts[2] ? [{ label: 'Amount', value: parts[2] }] : [])]
    : [{ label: approval.tool === 'operate_login' ? 'Site' : 'Key', value: reference ? 'Saved credential' : parts[0]?.replace(/^(Reveal|Edit|Delete|Sign in to) /, '') || 'Saved credential' },
       { label: 'Can', value: approval.tool === 'fetch_credential' ? 'Read the key value' : approval.action ?? squireApprovalAction(approval.tool, approval.detail, approval.linkKind) }]);
  const actions: TranscriptCardAction[] = [];
  if (approval.sourceRoomId && approval.sourceMessageId && onOpenSource) actions.push({
    label: 'View request', accessibilityRole: 'link',
    onPress: () => onOpenSource(approval.sourceRoomId!, approval.sourceMessageId!), testID: 'squire-approval-source',
  });
  if (!settled) actions.push({ label: approval.linkKind === 'passkey' ? 'Use passkey ↗' : approval.linkKind === 'vouch' ? 'Vouch ↗' : 'Review ↗',
    primary: true, accessibilityRole: 'link', onPress: () => void openExternalUrl(approval.approvalUrl), testID: 'squire-approval-open' });
  return <AgentApprovalCard tier={settled ? 'record' : 'ask'} testID="squire-approval-card" wrapTitle
    askingAgent={approval.agent} agent={agent}
    title={`@${name.replace(/^@/, '')} wants to ${approval.action ?? squireApprovalAction(approval.tool, approval.detail, approval.linkKind)}`}
    subline={`${approval.tool === 'Link' ? 'Link' : 'Trusty Squire'} · ${approvalAudience(approval.owner, viewerPubkey)}`}
    sublineTestID="squire-approval-detail" stamp={ledgerStamp(message.timestamp)}
    body={approval.reason} facts={facts} foldCode codeLabel="vault reference" code={reference} codePath={reference ? 'vault reference' : undefined}
    footerNote={approval.status ? approvalDecisionNote(approval.status, approval.decidedBy, approval.decidedAt ?? message.timestamp, viewerPubkey, approval.action ?? squireApprovalAction(approval.tool, approval.detail, approval.linkKind)) : undefined}
    decisionNote={settled} actions={actions} />;
});

export interface ConnectorOfferCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  /** The server's Workspace owner/admin decision (`viewer.permissions.manage`). */
  viewerCanManage?: boolean;
  /** The offer whose acceptance is in flight. */
  actionId: string | null;
  onAccept(
    offerId: string,
    connectorType: NonNullable<ChatDisplayMessage['connectorOffer']>['connectorType'],
  ): void;
  /** Reopens an accepted ceremony that has not reached connected yet. */
  onContinue?(
    offerId: string,
    connectorType: NonNullable<ChatDisplayMessage['connectorOffer']>['connectorType'],
    connectorId: string,
  ): void;
  /** Opens the Workbench page — the settled card is one of its three remaining doors. */
  onOpenWorkbench(): void;
  onDecline?(offerId: string): void;
}

export function AppSignInCard({ message, agentName, canConnect, onConnect, busy }: {
  message: ChatDisplayMessage;
  agentName: string;
  canConnect: boolean;
  onConnect: () => void;
  busy: boolean;
}) {
  const app = message.appSignIn!;
  if (app.status === 'connected')
    return (
      <Text style={appSignInStyles.settled}>{app.name.toUpperCase()} CONNECTED · {agentName.toUpperCase()} CONTINUES</Text>
    );
  return (
    <View style={appSignInStyles.wrap} testID={`app-sign-in-${app.appKey}`}>
      <View style={appSignInStyles.card}>
        <View style={appSignInStyles.heading}>
          <AppMark
            name={app.name}
            domain={app.domain}
            logo={app.logo}
            size={36}
          />
          <Text style={appSignInStyles.title}>Connect {app.name}</Text>
        </View>
        <Text style={appSignInStyles.detail}>Sign in once. {app.continuation ?? `${agentName} continues the request right after.`}</Text>
        {app.appKey === 'instagram' ? (
          <Text style={appSignInStyles.detail}>{INSTAGRAM_SIGN_IN_REQUIREMENT}</Text>
        ) : null}
        {app.status === 'failed' ? (
          <Text accessibilityRole="alert" style={appSignInStyles.error}>{app.errorMessage ?? 'App sign-in failed. Try again.'}</Text>
        ) : null}
        {canConnect ? (
          <Button disabled={busy} label={busy ? 'Connecting' : app.status === 'failed' ? `Retry ${app.name}` : `Connect ${app.name}`} onPress={onConnect} style={appSignInStyles.button} testID={`app-sign-in-${app.appKey}-connect`} />
        ) : (
          <Text style={appSignInStyles.detail}>Waiting for the account owner to connect {app.name}.</Text>
        )}
      </View>
    </View>
  );
}

const appSignInStyles = StyleSheet.create(theme => {
  const board = appBoardColors(theme.buzz);
  return {
  wrap: { gap: 8, marginVertical: 8, marginHorizontal: 8 },
  // The TranscriptCard frame, read from the same tokens (DESIGN.md → Transcript cards).
  card: {
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.transcriptCard.cornerRadius,
    padding: theme.buzz.transcriptCard.side,
    gap: theme.buzz.space.sm,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  title: { ...theme.buzz.type.bodyStrong, color: board.ink },
  detail: { ...theme.buzz.type.meta, color: board.secondary },
  error: { ...theme.buzz.type.meta, color: theme.buzz.dialogDanger },
  button: { alignSelf: 'flex-start' },
  settled: { ...theme.buzz.type.sectionHead, color: board.quiet, marginVertical: 8, marginHorizontal: 8 },
  };
});

export const ConnectorOfferCard = React.memo(function ConnectorOfferCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerCanManage = false,
  actionId,
  onAccept,
  onContinue,
  onOpenWorkbench,
  onDecline,
}: ConnectorOfferCardProps) {
  const offer = message.connectorOffer!;
  const display = resolveAgentDisplayIdentity(offer.agent.pubkey, agent);
  const agentName = agent ? display.name : offer.agent.name;
  const pending = offer.status === 'pending';
  const connecting = offer.status === 'connecting';
  const canAccept =
    !viewerIsAgent &&
    (viewerPubkey === offer.addressee.pubkey || viewerCanManage);
  const busy = actionId === offer.offerId;
  const actions: TranscriptCardAction[] =
    pending && canAccept
      ? [
          {
            label: offer.intent === 'switch' ? 'Switch' : offer.intent === 'reconnect' ? 'Reconnect' : 'Add',
            primary: true,
            disabled: actionId !== null,
            loading: busy,
            onPress: () => onAccept(offer.offerId, offer.connectorType),
            testID: `connector-offer-${offer.offerId}-accept`,
          },
        ]
      : connecting && canAccept && (offer.intent !== 'reconnect' || viewerPubkey === offer.addressee.pubkey) && offer.connectorId && onContinue
        ? [
            {
              label: 'Continue sign-in ›',
              primary: true,
              onPress: () => onContinue(offer.offerId, offer.connectorType, offer.connectorId!),
              testID: `connector-offer-${offer.offerId}-continue`,
            },
          ]
        : !pending && !connecting
          ? [
              {
                label: 'Manage ›',
                accessibilityRole: 'link',
                onPress: onOpenWorkbench,
                testID: `connector-offer-${offer.offerId}-workbench`,
              },
            ]
          : [];
  return (
    <AgentApprovalCard
      tier={pending || connecting ? 'ask' : 'record'}
      testID={`connector-offer-${pending ? 'pending' : connecting ? 'connecting' : 'settled'}`} wrapTitle
      askingAgent={offer.agent} agent={agent}
      title={`@${agentName.replace(/^@/, '')} wants to ${offer.intent === 'reconnect' ? 'reconnect' : offer.intent === 'switch' ? 'switch' : 'add'} ${offer.connectorName}`}
      subline={`Connectors · ${approvalAudience(offer.addressee, viewerPubkey)}`}
      sublineTestID={`connector-offer-${offer.offerId}-line`} body={offer.reason}
      facts={[{ label: 'Can', value: offer.connectorType === 'trusty-squire' ? 'Sign in to sites · use vault keys' : offer.connectorType === 'wallet' ? 'Sign transactions with your wallet' : 'Use the connected service' }, { label: 'Changes', value: 'Your Connectors' }]}
      decisionNote={!pending && !connecting}
      stamp={ledgerStamp(message.timestamp)}
      footerNote={
        connecting
          ? (connectorOfferConnectingLine(offer) ?? undefined)
          : pending
            ? canAccept
              ? undefined
              : connectorOfferWaitingLine(offer)
            : approvalDecisionNote(offer.status === 'denied' ? 'denied' : 'allowed', offer.acceptedBy, offer.acceptedAt ?? message.timestamp, viewerPubkey)
      }
      footerNoteTestID={
        connecting
          ? `connector-offer-${offer.offerId}-connecting`
          : pending
            ? canAccept
              ? undefined
              : `connector-offer-${offer.offerId}-waiting`
            : `connector-offer-${offer.offerId}-outcome`
      }
      actions={pending && canAccept && onDecline ? [{ label: 'No', secondary: true, onPress: () => onDecline(offer.offerId), testID: `connector-offer-${offer.offerId}-deny`, disabled: actionId !== null }, ...actions] : actions}
    />
  );
});

export interface ChoiceCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  actionId: string | null;
  onAnswer(choiceId: string, optionId: string, note?: string): void;
  onSkip(choiceId: string): void;
}

function choiceHandle(identity?: { handle?: string; name: string; pubkey: string }): string {
  const handle = identity?.handle?.replace(/^@/, '');
  return handle || identity?.name?.replace(/^@/, '') || 'someone';
}

/**
 * One choice family: lettered plates for a question or a poll. Skip is a footer
 * word on an open question. Closed polls carry a still brass wash; options are
 * never TranscriptCardRow.
 */
export const ChoiceCard = React.memo(function ChoiceCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  actionId,
  onAnswer,
  onSkip,
}: ChoiceCardProps) {
  const card = message.choice!;
  const display =
    card.agent.kind === 'agent' ? resolveAgentDisplayIdentity(card.agent.pubkey, agent) : null;
  const agentName = display && agent ? display.name : card.agent.name;
  const open = card.status === 'open';
  const viewerVote = card.responses.find((response) => response.identityId === viewerPubkey);
  const canAct =
    open && !viewerIsAgent && (card.mode === 'question' || card.electorate.includes(viewerPubkey));
  const busy = actionId === card.choiceId;
  // Only a workflow gate takes a note; its outcome still comes from the pick.
  const takesNote = canAct && card.mode === 'question' && !!card.runId;
  const [note, setNote] = React.useState('');
  const answer = (optionId: string) =>
    takesNote && note.trim()
      ? onAnswer(card.choiceId, optionId, note.trim())
      : onAnswer(card.choiceId, optionId);
  const turnout = `${card.votedCount} of ${card.electorateCount} voted`;
  const clock = card.closesAt ? `closes ${formatChoiceClock(card.closesAt)}` : undefined;
  const subline =
    card.mode === 'poll'
      ? [clock, turnout].filter(Boolean).join(' · ')
      : [card.constraint, clock].filter(Boolean).join(' · ') || undefined;
  const choices: TranscriptCardChoice[] = card.options.map((option) => ({
    id: option.optionId,
    letter: option.letter,
    label: option.label,
    consequence: option.consequence === option.label ? '' : option.consequence,
    costly: option.costly,
    votes: option.votes,
    share: option.share,
    leader: option.leader,
    selected: viewerVote?.optionId === option.optionId || card.selectedOptionId === option.optionId,
    ...(canAct && card.mode === 'poll'
      ? { onPress: () => answer(option.optionId) }
      : canAct && card.mode === 'question' && !busy
        ? { onPress: () => answer(option.optionId) }
        : {}),
  }));
  const actions: TranscriptCardAction[] =
    canAct && card.mode === 'question'
      ? [
          {
            label: 'Skip',
            disabled: busy,
            onPress: () => onSkip(card.choiceId),
            testID: `choice-${card.choiceId}-skip`,
          },
        ]
      : [];
  return (
    <TranscriptCard
      tier={open ? 'ask' : 'record'}
      testID={`choice-${card.choiceId}`}
      identity={
        <IdentityMark
          kind={card.agent.kind}
          seed={display?.avatarSeed ?? card.agent.pubkey}
          avatarUrl={display?.avatarUrl ?? card.agent.avatar}
          face={display?.face ?? card.agent.face}
          name={agentName}
          size={26}
        />
      }
      title={card.prompt}
      wrapTitle
      subline={subline || card.constraint}
      sublineTestID={`choice-${card.choiceId}-subline`}
      stamp={ledgerStamp(message.timestamp)}
      choices={choices}
      noteInput={
        takesNote
          ? {
              value: note,
              onChangeText: setNote,
              placeholder: 'Add a note (optional)',
              maxLength: CHOICE_NOTE_MAX_LENGTH,
              editable: !busy,
              testID: `choice-${card.choiceId}-note`,
            }
          : undefined
      }
      footerNote={
        open
          ? busy ? 'Sending decision…' : undefined
          : card.footer ||
            (card.status === 'answered'
              ? `picked ${card.selectedOptionId ?? ''} · @${choiceHandle(card.answeredBy)}`
              : undefined)
      }
      footerNoteTestID={`choice-${card.choiceId}-footer`}
      actions={actions}
    />
  );
});

/**
 * The @wallet thread's cards: every transaction, the one refusal, and the
 * delegation grant. The @wallet line itself already carries the ledger
 * prose; the card is the structured layer on top (mock §The @wallet thread).
 */
export const WalletCards = React.memo(function WalletCards({
  message,
  stamp,
}: {
  message: ChatDisplayMessage;
  stamp: string;
}) {
  const tx = message.walletTx;
  const refusal = message.walletInsufficient;
  const delegation = message.walletDelegation;
  const walletIdentity = message.authorIdentity;
  const identity = (
    <IdentityMark
      kind="human"
      seed={walletIdentity?.pubkey ?? 'wallet'}
      name={walletIdentity?.name ?? 'Wallet'}
      avatarUrl={walletIdentity?.avatar}
      face={walletIdentity?.face}
      size={26}
    />
  );
  if (tx) {
    const actor = tx.agentName ? `@${tx.agentName.replace(/^@/, '')}` : 'You';
    return (
      <TranscriptCard
        tier="record"
        identity={identity}
        title={
          tx.direction === 'out' ? `${actor} sent ${tx.amountText}` : `Received ${tx.amountText}`
        }
        subline={`${tx.counterparty} · ${tx.chain} · ${tx.balanceAfterUsd} left`}
        sublineTestID="wallet-tx-subline"
        stamp={stamp}
        testID={`wallet-tx-${tx.direction}`}
      />
    );
  }
  if (refusal) {
    const actor = refusal.agentName ? `@${refusal.agentName.replace(/^@/, '')}` : 'You';
    return (
      <TranscriptCard
        tier="record"
        identity={identity}
        title={
          refusal.reason ? `${actor} could not pay · ${refusal.reason}` : `${actor} could not pay`
        }
        subline={`Needed ${refusal.needed} ${refusal.asset} on ${refusal.chain}${
          refusal.available ? ` · ${refusal.available} available` : ''
        }`}
        sublineTestID="wallet-insufficient-subline"
        stamp={stamp}
        testID="wallet-insufficient"
      />
    );
  }
  if (delegation) {
    return (
      <TranscriptCard
        tier="record"
        identity={identity}
        title="Granted agents permission to sign"
        subline={
          'standing' in delegation
            ? 'Stands until revoked'
            : `Until ${new Date(delegation.expiresAt).toLocaleString()} · renews in the app`
        }
        sublineTestID="wallet-delegation-subline"
        stamp={stamp}
        testID="wallet-delegation"
      />
    );
  }
  return null;
});

/**
 * An agent's order into, or report from, a corner reads as ordinary transcript.
 * The recipient becomes the first word as a plain @mention; the byline still
 * names the agent that wrote it, and every other message action stays available.
 * The record card that used to wrap these rows is gone.
 */
export function agentCommandTranscriptMessage(
  message: ChatDisplayMessage,
  participants: readonly { pubkey: string; handle: string }[],
): ChatDisplayMessage {
  const command = message.agentCommand;
  if (!command) return message;
  const participant = participants.find((candidate) => candidate.pubkey === command.recipient.id);
  const handle = (
    participant?.handle ??
    command.recipient.handle ??
    command.recipient.name
  ).replace(/^@/, '');
  // Keep agentCommand on the row: the text is display-only, but Reply needs
  // the marker to give this card row the same-Room parent proof it lacks.
  return {
    ...message,
    text: `@${handle} ${command.text}`,
  };
}

export interface TargetBranchProposalCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  currentTargetBranch?: string;
  canManageWorkspace: boolean;
  viewerIsAgent: boolean;
  actionId: string | null;
  notice: string | null;
  onConfirm(message: ChatDisplayMessage): void;
  onDeny?(message: ChatDisplayMessage): void;
  viewerPubkey?: string;
  roomName?: string;
}

export const TargetBranchProposalCard = React.memo(function TargetBranchProposalCard({
  message,
  agent,
  currentTargetBranch,
  canManageWorkspace,
  viewerIsAgent,
  actionId,
  notice,
  onConfirm, onDeny, viewerPubkey, roomName,
}: TargetBranchProposalCardProps) {
  const proposal = message.targetBranchProposal!;
  const applied = proposal.status === 'allowed' || currentTargetBranch === proposal.to;
  const settled = applied || proposal.status === 'denied';
  const busy = actionId === proposal.proposalId;
  const canConfirm = !viewerIsAgent && canManageWorkspace;
  const askingAgent = proposal.agentPubkey
    ? resolveAgentDisplayIdentity(proposal.agentPubkey, agent).name.replace(/^@/, '')
    : undefined;
  return (
    <AgentApprovalCard tier={settled ? 'record' : 'ask'} testID="target-branch-proposal" wrapTitle
      askingAgent={{ pubkey: proposal.agentPubkey ?? '', kind: 'agent', name: askingAgent ?? 'Agent' }} agent={agent}
      title={`@${askingAgent ?? 'Agent'} wants to change the target branch`}
      subline={`${roomName ? `#${roomName}` : proposal.repository ?? 'Room'} · for you`}
      stamp={ledgerStamp(message.timestamp)} body={proposal.purpose}
      facts={[{ label: 'From', value: proposal.from }, { label: 'To', value: proposal.to }, { label: 'Can', value: `Rebase open corners onto ${proposal.to}` }]}
      footerNote={settled ? approvalDecisionNote(proposal.status ?? 'allowed', proposal.decidedBy, proposal.decidedAt ?? message.timestamp, viewerPubkey) : canConfirm ? notice ?? undefined : 'waiting for a Workspace manager'}
      decisionNote={settled}
      actions={!settled && canConfirm ? [
        ...(onDeny ? [{ label: 'No', secondary: true, disabled: busy, onPress: () => onDeny(message), testID: 'target-branch-deny' }] : []),
        { label: 'Confirm', primary: true, loading: busy, disabled: busy, onPress: () => onConfirm(message), testID: 'target-branch-confirm' },
      ] : []} />
  );
});


/**
 * Attachment bytes are kept for 24 hours (`apps/server/src/media-ttl.ts`); the
 * message that carried them is kept forever. Past the window the server marks
 * the attachment `expired`, and the row says so in the same metrics as a live
 * one — the name, type and size the message still holds, inscribed rather than
 * framed. Nothing is fetched and nothing opens: there is no longer a file
 * behind the link, and a broken thumbnail or a spinner would say otherwise.
 */
function AttachmentCard({
  attachment,
  isDesktop,
}: {
  attachment: AttachmentReference;
  isDesktop: boolean;
}) {
  const image =
    !attachment.expired && attachment.mimeType.startsWith('image/') && attachment.thumbnailUrl;
  const [mediaAuthorization, setMediaAuthorization] = useState<string>();
  useEffect(() => {
    if (!image) return;
    let live = true;
    void monolithSession
      .authorization()
      .then((token) => {
        if (live) setMediaAuthorization(`Bearer ${token}`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [image]);
  const open = () => {
    // A picture opens the same centered full-screen viewer on every surface,
    // desktop included; the work pane keeps only its documents.
    if (attachment.mimeType.startsWith('image/')) {
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
    <Pressable
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
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{
            uri: attachment.thumbnailUrl,
            ...(mediaAuthorization ? { headers: { authorization: mediaAuthorization } } : {}),
          }}
          style={styles.attachmentThumbnail}
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
      <Text style={styles.attachmentOpenGlyph}>↗</Text>
    </Pressable>
  );
}

function SwipeToReply({
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
  const swipeableRef = useRef<Swipeable | null>(null);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelReturn = useCallback(() => {
    clearTimeout(returnTimer.current);
    clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => cancelReturn, [cancelReturn, messageId]);
  const commitSwipe = (direction: 'left' | 'right') => {
    cancelReturn();
    // WillOpen runs after the swipe commits, even if its opening spring is
    // interrupted. Wait for Swipeable's rowState update before closing it.
    closeTimer.current = setTimeout(() => {
      swipeableRef.current?.close();
      // A cancelled closing spring must not leave the action panel exposed.
      returnTimer.current = setTimeout(() => swipeableRef.current?.reset(), 240);
    }, 0);
    // Install the quote before a composer update can recycle this row.
    if (direction === 'right') onReply?.();
    else onSwipeCorner?.();
  };
  const [desktopActionsVisible, setDesktopActionsVisible] = useState(false);
  const [desktopRowHovered, setDesktopRowHovered] = useState(false);
  const [reactionPickerVisible, setReactionPickerVisible] = useState(false);
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
        <View
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
        </View>
        {!replyOnly && reactionPickerVisible ? (
          <View style={styles.reactionPicker} testID={`reaction-picker-${messageId}`}>
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
          </View>
        ) : null}
      </View>
    );
  }
  const cornerAction = (poseStyle?: object) => (
    <View
      accessibilityLabel={`Forward message to a new ${CORNER_LABEL}`}
      style={[styles.cornerSwipeAction, poseStyle]}
      testID={`corner-swipe-action-${messageId}`}
    >
      <CornerGlyph color={styles.cornerSwipeGlyph.color} size={20} />
      <Text style={styles.replySwipeLabel}>{CORNER_LABEL.toUpperCase()}</Text>
    </View>
  );
  const swipeRow = () => (
    <Swipeable
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
      onSwipeableOpenStartDrag={cancelReturn}
      onSwipeableCloseStartDrag={cancelReturn}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={onSwipeCorner ? () => cornerAction() : undefined}
      renderRightActions={onReply ? () => (
        <View
          accessibilityLabel="Reply to message"
          style={styles.replySwipeAction}
          testID={`reply-swipe-action-${messageId}`}
        >
          <Text style={styles.replySwipeGlyph}>↩</Text>
          <Text style={styles.replySwipeLabel}>REPLY</Text>
        </View>
      ) : undefined}
      enabled={Boolean(onReply || onSwipeCorner)}
      testID={`swipe-reply-${messageId}`}
    >
      {message}
    </Swipeable>
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
  onRetry(eventId: string): void;
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
function ViewerContextReference({ context, attachment, roomId, timestamp, isDesktop, testID }: {
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

export const OrdinaryLedgerMessage = React.memo(function OrdinaryLedgerMessage({
  message,
  agent,
  agentModel,
  participantsHydrated,
  personName,
  viewerPubkey,
  speakerWorking,
  continued,
  immediatelyPrecedingMessage,
  firstBylineOfDay,
  referencedTarget,
  participantHandles,
  channelIndex,
  deliveryFailed,
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
  onRetry,
  onDismiss,
  announcementFeed = false,
  desktopLayout = false,
}: OrdinaryLedgerMessageProps) {
  const replyAvailable = canBeginReply(message, codeRoomId ?? message.reference?.channelId ?? '');
  const isOwn = message.isUser;
  const indexedAuthor = message.authorIdentity;
  // A loaded roster entry is the current identity. Historical rows may still
  // carry the face or generated avatar that was current when they were cached,
  // including artwork the agent has since removed.
  const speakerFace = agent ? agent.face : indexedAuthor?.face;
  const speakerAvatar = agent ? agent.avatar : indexedAuthor?.avatar;
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

  const content = (
    <NewMessageMaterialize enabled={Boolean(message.isNew)} messageId={message.id}>
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
        {message.isUser && deliveryFailed ? (
          <View style={styles.outboxFailure} testID={`outbox-delivery-failed-${message.id}`}>
            <Text style={styles.outboxFailureText}>DELIVERY FAILED</Text>
            <HullDialogActions
              actions={[
                { label: 'Dismiss', onPress: () => onDismiss(message.id) },
                { label: 'Retry', variant: 'primary', onPress: () => onRetry(message.id) },
              ]}
            />
          </View>
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

const styles = StyleSheet.create((theme) => ({
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
  outboxFailure: {
    marginTop: 4,
    marginHorizontal: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgHighlight,
  },
  outboxFailureText: {
    ...theme.buzz.type.sectionHead,
    fontFamily: theme.buzz.monoSemibold,
    color: theme.buzz.textPrimary,
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
    position: 'absolute',
    top: 46,
    right: 0,
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
    ...theme.buzz.type.body,
    width: 22,
    color: theme.buzz.steel,
    textAlign: 'center',
  },

replyDesktopLabel: {
    ...theme.buzz.type.sectionHead,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.textMuted,
  },
}));
