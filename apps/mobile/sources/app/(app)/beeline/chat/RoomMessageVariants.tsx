import { ChoiceVideoPreview } from '@/components/buzz/ChoiceVideoPreview';
import { funnelOnboarding } from '@/auth/signin-funnel';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { NotificationLifecycleCard } from '@/components/buzz/PrLifecycleCard';
import { StyleSheet } from 'react-native-unistyles';
import { CHOICE_NOTE_MAX_LENGTH, formatChoiceClock } from '@beeline/api-contract/phone';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { connectorOfferWaitingLine } from '@/buzz/connector-offer-copy';
import { AppMark } from '@/components/buzz/AppMark';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';
import { appBoardColors } from '@/buzz/app-board-style';
import { ledgerStamp } from '@/buzz/relative-time';
import { squireApprovalAction } from '@beeline/api-contract/phone';
import { AgentApprovalCard, approvalAudience, approvalDecisionNote } from '@/components/buzz/AgentApprovalCard';
import { openExternalUrl } from '@/utils/open-external-url';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { Button } from '@/components/buzz/Button';
import { TranscriptCard, TranscriptCardHandle, type TranscriptCardAction, type TranscriptCardChoice } from '@/components/buzz/TranscriptCard';
import { OrdinaryLedgerMessageProps, agentBylineLabel, ConnectorReceiptCard } from './RoomMessageVariants-attachment-card';
import { OrdinaryLedgerMessage } from './RoomMessageVariants-ordinary-ledger-message';



type WriteDecision = 'allow' | 'deny';


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
              label: 'Open',
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
      footerNoteTestID={pending && permission.repository && !canDecide ? 'brief-approval-audience-wait' : undefined}
      footerNoteTone={permission.status === 'failed' || (pending && !permission.repository) ? 'failed' : 'quiet'}
      actions={actions}
    />
  );
});


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
  if (!settled) actions.push({ label: approval.linkKind === 'passkey' ? 'Use passkey' : approval.linkKind === 'vouch' ? 'Vouch' : 'Review',
    accessibilityRole: 'link', destination: 'external', onPress: () => void openExternalUrl(approval.approvalUrl), testID: 'squire-approval-open' });
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
  onOpenReplacement(messageId: string): void;
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
          <ErrorBanner inline title={(app.errorMessage ?? 'App sign-in failed. Try again.')} />
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
  // A single decision sits where a ButtonRow puts its confirm: at the trailing edge.
  button: { alignSelf: 'flex-end' },
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
  onOpenReplacement,
  onDecline,
}: ConnectorOfferCardProps) {
  const offer = message.connectorOffer!;
  const display = resolveAgentDisplayIdentity(offer.agent.pubkey, agent);
  const agentName = agent ? display.name : offer.agent.name;
  const pending = offer.status === 'pending';
  const failed = offer.status === 'failed';
  const connecting = offer.status === 'connecting';
  const canAccept =
    !viewerIsAgent &&
    (viewerPubkey === offer.addressee.pubkey || viewerCanManage);
  const busy = actionId === offer.offerId;
  const actions: TranscriptCardAction[] =
    (pending || failed) && canAccept
      ? [
          {
            label: failed ? offer.replacementMessageId ? 'Open current card' : 'Retry' : offer.intent === 'switch' ? 'Switch' : offer.intent === 'reconnect' ? 'Reconnect' : 'Add',
            primary: true,
            disabled: actionId !== null,
            loading: busy,
            onPress: () => offer.replacementMessageId
              ? onOpenReplacement(offer.replacementMessageId)
              : onAccept(offer.offerId, offer.connectorType),
            testID: `connector-offer-${offer.offerId}-accept`,
          },
        ]
      : connecting && canAccept && (offer.intent !== 'reconnect' || viewerPubkey === offer.addressee.pubkey) && offer.connectorId && onContinue
        ? [
            {
              label: 'Continue sign-in',
              primary: true,
              onPress: () => onContinue(offer.offerId, offer.connectorType, offer.connectorId!),
              testID: `connector-offer-${offer.offerId}-continue`,
            },
          ]
        : !pending && !connecting
          ? [
              {
                label: 'Manage',
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
      subline={offer.addressee.pubkey === viewerPubkey ? undefined : approvalAudience(offer.addressee, viewerPubkey)}
      sublineTestID={`connector-offer-${offer.offerId}-line`} body={offer.reason}
      facts={offer.connectorType === 'trusty-squire'
        ? [{ label: 'Can', value: 'Sign in to sites · use vault keys' }]
        : offer.connectorType === 'wallet'
          ? [{ label: 'Can', value: 'Sign transactions with your wallet' }]
          : undefined}
      decisionNote={!pending && !connecting}
      stamp={ledgerStamp(message.timestamp)}
      footerNote={
        connecting
          ? (offer.intent === 'reconnect' && !offer.acceptedBy ? 'Reconnecting…' : undefined)
          : pending
            ? canAccept
              ? undefined
              : connectorOfferWaitingLine(offer)
            : failed ? offer.replacementMessageId ? 'This card was replaced. Use the current connection card.' : 'Connection failed. Retry to continue.' : approvalDecisionNote(offer.status === 'denied' ? 'denied' : 'allowed', offer.acceptedBy, offer.acceptedAt ?? message.timestamp, viewerPubkey)
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
 * word on an open question. Settled questions show their decision without
 * option plates. Closed polls retain their vote results in a still brass wash.
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
  React.useEffect(() => {
    if (card.starterOnboarding === 'welcome' && !card.onboardingManual) void funnelOnboarding('welcome_shown');
  }, [card.choiceId, card.starterOnboarding, card.onboardingManual]);
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
  const clock = open && card.closesAt ? `closes ${formatChoiceClock(card.closesAt)}` : undefined;
  const subline =
    card.mode === 'poll'
      ? [clock, turnout].filter(Boolean).join(' · ')
      : open
        ? [card.constraint, clock].filter(Boolean).join(' · ') || undefined
        : undefined;
  const selectedOption = card.options.find((option) => option.optionId === card.selectedOptionId);
  const decision = card.footer ||
    (card.status === 'answered'
      ? `picked ${card.selectedOptionId ?? ''} · @${choiceHandle(card.answeredBy)}`
      : card.status === 'skipped'
        ? 'Skipped'
        : card.mode === 'question' ? 'Closed · no longer waiting for an answer' : undefined);
  const footer = card.mode === 'question' && card.status === 'answered' && selectedOption
    ? `${selectedOption.label} · ${decision}`
    : decision;
  const choices: TranscriptCardChoice[] = (!open && card.mode === 'question' ? [] : card.options).map((option) => ({
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
            dismiss: true,
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
      subline={subline}
      sublineTestID={`choice-${card.choiceId}-subline`}
      stamp={ledgerStamp(message.timestamp)}
      body={card.videoPreview ? <ChoiceVideoPreview {...card.videoPreview} /> : undefined}
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
          : footer
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
export { GitHubEventCard, DaemonFactCard } from '@/components/buzz/LifecycleCard';
export { NotificationLifecycleCard };
export { GrantRequestCard, type GrantDecision, type GrantRequestCardProps } from '@/components/buzz/GrantRequestCard';
export type { OrdinaryLedgerMessageProps } from './RoomMessageVariants-attachment-card';
export { agentBylineLabel } from './RoomMessageVariants-attachment-card';
export { ConnectorReceiptCard } from './RoomMessageVariants-attachment-card';
export { OrdinaryLedgerMessage } from './RoomMessageVariants-ordinary-ledger-message';
