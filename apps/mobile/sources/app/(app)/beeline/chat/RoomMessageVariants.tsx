import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import {
  MESSAGE_REACTION_EMOJIS,
  type AttachmentReference,
  type MessageReactionEmoji,
} from '@beeline/buzz-client';

import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import { agentActivityReplyExcerpt, type MessageReplyDisplayTarget } from '@/buzz/message-reply';
import { resolveAgentDisplayIdentity, resolvePendingAgentDisplay } from '@/buzz/agent-display';
import { fallbackMemberName } from '@/buzz/member-display';
import { describeWriteRequest } from '@/buzz/write-request-copy';
import { grantAskLine } from '@/buzz/agent-grant-copy';
import { shouldShowReplyReference } from '@/buzz/reply-reference';
import {
  draftRequestId,
  provisionalDraftKey,
  rememberProvisionalDraft,
  takeProvisionalDraft,
} from '@/buzz/draft-settle';
import { splitLedgerText } from '@/buzz/ledger-text';
import { ledgerStamp } from '@/buzz/relative-time';
import { formatNotificationHeadlines } from '@/buzz/system-lines';
import { attachmentOpenUrl, formatAttachmentSize } from '@/buzz/chat-attachment';
import { ROOM_LABEL, CORNER_LABEL } from '@/buzz/vocabulary';
import { cornerName } from '@/buzz/corners';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { openExternalUrl } from '@/utils/open-external-url';
import { ActivityTimeline } from '@/components/buzz/ActivityTimeline';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { ALIVE_RING_PAD } from '@/buzz/identity-mark';
import {
  LedgerEntry,
  LedgerGhostLine,
  LedgerSystemLine,
  LedgerSteer,
  type LedgerByline,
} from '@/components/buzz/Ledger';
import { MonoButton, NewMessageMaterialize } from '@/components/buzz/MonoHull';
import { HullActionSheetModal } from '@/components/buzz/HullActionSheet';
import {
  TranscriptCard,
  TranscriptCardHandle,
  type TranscriptCardAction,
  type TranscriptCardRow,
} from '@/components/buzz/TranscriptCard';
import { forwardedMessageParts } from '@/buzz/message-forward';

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
  viewerRole: 'owner' | 'admin' | 'member' | null;
  actionId: string | null;
  targetBranch?: string;
  onDecision(message: ChatDisplayMessage, decision: WriteDecision): void;
  onOpenCorner(cornerId: string): void;
}

export const WritePermissionCard = React.memo(function WritePermissionCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerRole,
  actionId,
  targetBranch,
  onDecision,
  onOpenCorner,
}: WritePermissionCardProps) {
  const permission = message.writePermission!;
  const squireSpending = permission.purpose === 'squire-spending';
  const display = resolveAgentDisplayIdentity(permission.agentPubkey, agent);
  const pending = permission.status === 'pending';
  const busy = actionId === permission.permissionId;
  const canDecide =
    !viewerIsAgent &&
    (viewerPubkey === permission.requesterPubkey ||
      viewerRole === 'admin' ||
      viewerRole === 'owner');
  const footerNote = pending
    ? !permission.repository
      ? 'missing target'
      : squireSpending && viewerRole !== 'owner'
        ? 'owner confirmation'
        : !canDecide
          ? 'requester or room admin'
          : 'owner confirmation'
    : permission.status === 'allowed'
      ? 'allowed once'
      : permission.status === 'denied'
        ? 'denied'
        : permission.status === 'failed'
          ? 'corner could not open'
          : 'request expired';
  const actions: TranscriptCardAction[] =
    pending && canDecide && permission.repository && (!squireSpending || viewerRole === 'owner')
      ? [
          {
            label: 'Deny',
            disabled: busy,
            onPress: () => onDecision(message, 'deny'),
            testID: 'write-permission-deny',
          },
          {
            label: 'Allow',
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
    <TranscriptCard
      tier={pending ? 'ask' : 'record'}
      testID={`write-permission-${permission.status}`}
      identity={
        <IdentityMark
          kind="agent"
          seed={display.avatarSeed ?? permission.agentPubkey}
          avatarUrl={display.avatarUrl}
          face={display.face}
          name={display.name}
          size={26}
        />
      }
      title={
        <>
          <TranscriptCardHandle>@{display.name.replace(/^@/, '')}</TranscriptCardHandle>{' '}
          {squireSpending ? 'asks for spending approval' : 'asks to open an edit corner'}
        </>
      }
      subline={describeWriteRequest(permission.tool)}
      stamp={ledgerStamp(message.timestamp)}
      code={
        permission.repository
          ? `${permission.repository}${targetBranch ? ` · ${targetBranch}` : ''}`
          : undefined
      }
      body={
        squireSpending
          ? 'Trusty Squire stays in its vault-backed process. Only the Room owner can confirm this spending or checkout-capable action.'
          : permission.repository
            ? 'Opening a corner gives the agent a branch, not merge authority. A person still approves the merge.'
            : 'This write request is missing its repository target and cannot be allowed.'
      }
      quietBody
      footerNote={footerNote}
      footerNoteTestID={
        pending && permission.repository && !canDecide ? 'corner-approval-audience-wait' : undefined
      }
      footerNoteTone={
        permission.status === 'failed' || (pending && !permission.repository) ? 'failed' : 'quiet'
      }
      actions={actions}
    />
  );
});

export type GrantDecision = 'always' | 'once' | 'deny';

export interface GrantRequestCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  viewerRole: 'owner' | 'admin' | 'member' | null;
  /** The grant whose decision is in flight. */
  actionId: string | null;
  onDecision(grantId: string, decision: GrantDecision): void;
}

/**
 * The grant card: `<agent> asks <owner>`, one `<verb> <target>` line per grant with
 * its reason in quiet text, and ALWAYS / ONCE / NO for the owner or a Workspace
 * manager. An interpreter command carries its SCRIPT (C94) — `python3 fix.py`
 * describes nothing, so the body the approval is bound to is inscribed under the
 * ask in the machine role, and the server refuses rather than truncating one too
 * long to read. Everyone else reads the ask and `waiting for <owner>`. After the tap
 * each line settles into its inscribed outcome exactly as the write-permission
 * card does; the phone mirrors the server's authority, it never decides it.
 */
export const GrantRequestCard = React.memo(function GrantRequestCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerRole,
  actionId,
  onDecision,
}: GrantRequestCardProps) {
  const request = message.grantRequest!;
  const display = resolveAgentDisplayIdentity(request.agent.pubkey, agent);
  // The server names the asking agent on the card; a loaded roster presentation
  // (soul name) wins once it exists, never a fallback placeholder.
  const agentName = agent ? display.name : request.agent.name;
  const canDecide =
    !viewerIsAgent &&
    (viewerPubkey === request.owner.pubkey || viewerRole === 'admin' || viewerRole === 'owner');
  const anyPending = request.grants.some((grant) => grant.status === 'pending');
  return (
    <View testID={`grant-request-${anyPending ? 'pending' : 'settled'}`}>
      {request.grants.map((grant) => {
        const busy = actionId === grant.grantId;
        const pendingGrant = grant.status === 'pending';
        const actions: TranscriptCardAction[] =
          pendingGrant && canDecide
            ? [
                {
                  label: 'No',
                  disabled: actionId !== null,
                  onPress: () => onDecision(grant.grantId, 'deny'),
                  testID: `grant-${grant.grantId}-deny`,
                },
                {
                  label: 'Once',
                  disabled: actionId !== null,
                  onPress: () => onDecision(grant.grantId, 'once'),
                  testID: `grant-${grant.grantId}-once`,
                },
                {
                  label: 'Always',
                  primary: true,
                  disabled: actionId !== null,
                  loading: busy,
                  onPress: () => onDecision(grant.grantId, 'always'),
                  testID: `grant-${grant.grantId}-always`,
                },
              ]
            : [];
        return (
          <TranscriptCard
            key={grant.grantId}
            tier={pendingGrant ? 'ask' : 'record'}
            testID={`grant-${grant.grantId}`}
            identity={
              <IdentityMark
                kind="agent"
                seed={display.avatarSeed ?? request.agent.pubkey}
                avatarUrl={display.avatarUrl}
                face={display.face}
                name={agentName}
                size={26}
              />
            }
            title={
              <Text testID="grant-request-title">
                <TranscriptCardHandle>@{agentName.replace(/^@/, '')}</TranscriptCardHandle> asks you
              </Text>
            }
            subline={`${grantAskLine(grant)} · ${grant.reason}`}
            sublineTestID={`grant-${grant.grantId}-ask`}
            stamp={ledgerStamp(message.timestamp)}
            code={grant.script?.contents}
            codeTestID={grant.script ? `grant-${grant.grantId}-script` : undefined}
            codePath={grant.script?.path}
            footerNote={
              pendingGrant
                ? canDecide
                  ? undefined
                  : `waiting for @${request.owner.name.replace(/^@/, '')}`
                : grant.status === 'once'
                  ? 'allowed once'
                  : grant.status === 'approved'
                    ? 'always allowed'
                    : grant.status === 'denied'
                      ? 'denied'
                      : 'revoked'
            }
            footerNoteTone={
              grant.status === 'denied' || grant.status === 'revoked' ? 'failed' : 'quiet'
            }
            footerNoteTestID={!pendingGrant ? `grant-${grant.grantId}-outcome` : undefined}
            actions={actions}
          />
        );
      })}
    </View>
  );
});

export interface TargetBranchProposalCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  currentTargetBranch?: string;
  canManageWorkspace: boolean;
  viewerIsAgent: boolean;
  actionId: string | null;
  notice: string | null;
  onConfirm(message: ChatDisplayMessage): void;
}

export const TargetBranchProposalCard = React.memo(function TargetBranchProposalCard({
  message,
  agent,
  currentTargetBranch,
  canManageWorkspace,
  viewerIsAgent,
  actionId,
  notice,
  onConfirm,
}: TargetBranchProposalCardProps) {
  const proposal = message.targetBranchProposal!;
  const applied = currentTargetBranch === proposal.to;
  const busy = actionId === proposal.proposalId;
  const canConfirm = !viewerIsAgent && canManageWorkspace;
  const askingAgent = proposal.agentPubkey
    ? resolveAgentDisplayIdentity(proposal.agentPubkey, agent).name.replace(/^@/, '')
    : undefined;
  return (
    <TranscriptCard
      tier={applied ? 'record' : 'ask'}
      testID="target-branch-proposal"
      title={
        askingAgent ? (
          <>
            <TranscriptCardHandle>@{askingAgent}</TranscriptCardHandle>{' '}
            {applied ? 'asked to change the target branch' : 'asks to change the target branch'}
          </>
        ) : applied ? (
          'Target branch changed'
        ) : (
          'Change the target branch'
        )
      }
      stamp={ledgerStamp(message.timestamp)}
      code={`${proposal.from} → ${proposal.to}`}
      body={
        `Confirming republishes this ${ROOM_LABEL}'s repository binding under your key. ` +
        `${CORNER_LABEL}s already open automatically rebase onto ${proposal.to}.`
      }
      quietBody
      footerNote={
        applied ? 'confirmed' : canConfirm ? (notice ?? undefined) : 'workspace manager only'
      }
      footerNoteTone={!applied && !canConfirm ? 'failed' : 'quiet'}
      actions={
        !applied && canConfirm
          ? [
              {
                label: 'Confirm',
                primary: true,
                loading: busy,
                disabled: busy,
                onPress: () => onConfirm(message),
                testID: 'target-branch-confirm',
              },
            ]
          : []
      }
    />
  );
});

export interface GitHubEventCardProps {
  message: ChatDisplayMessage;
  onOpenUrl(url: string): void;
}

export interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}

type RepositoryFactCardProps = {
  title: React.ReactNode;
  subline?: React.ReactNode;
  stamp?: string;
  body?: React.ReactNode;
  rows?: readonly TranscriptCardRow[];
  actions?: readonly TranscriptCardAction[];
  onHeaderPress?(): void;
  headerExpanded?: boolean;
  testID: string;
};

/** Shared visual shell for verified GitHub events and daemon lifecycle facts. */
const RepositoryFactCard = React.memo(function RepositoryFactCard({
  title,
  subline,
  stamp,
  body,
  rows,
  actions,
  onHeaderPress,
  headerExpanded,
  testID,
}: RepositoryFactCardProps) {
  return (
    <TranscriptCard
      tier="record"
      title={title}
      subline={subline}
      stamp={stamp}
      body={body}
      rows={rows}
      actions={actions}
      onHeaderPress={onHeaderPress}
      headerExpanded={headerExpanded}
      headerTestID={onHeaderPress ? `${testID}-disclosure` : undefined}
      testID={testID}
    />
  );
});

/** One raised card for one uninterrupted run of repository notifications. */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
  onOpenCorner,
  onOpenUrl,
}: NotificationLifecycleCardProps) {
  const run = message.notificationLifecycleRun!;
  const [expanded, setExpanded] = useState(false);
  const isCheckBatch = run.items.every((item) => item.kind === 'check');
  const isPullRequestBatch = run.items.every(
    (item) => item.kind !== 'check' && /^(corner|PR)/i.test(item.kindLine),
  );
  const isFoldedBatch = isCheckBatch || isPullRequestBatch;
  const mergedTitle = isPullRequestBatch
    ? run.items.find((item) => item.state === 'Merged')?.title
    : undefined;
  const visibleItems = expanded
    ? run.items
    : isCheckBatch
      ? run.items.filter((item) => item.state === 'Checks failed')
      : isPullRequestBatch
        ? []
        : run.items.slice(0, 3);
  const hiddenCount = run.items.length - 3;
  const rows: TranscriptCardRow[] = visibleItems.map((item) => ({
    id: item.id,
    state:
      item.state === 'PR opened'
        ? 'opened'
        : item.state === 'Checks running'
          ? 'running'
          : item.state === 'Checks failed'
            ? 'failed'
            : item.state === 'Checks passed'
              ? 'passed'
              : item.state.toLowerCase(),
    title: item.title,
    kindLine: item.kindLine,
    tone:
      item.danger || item.state === 'Failed'
        ? 'failed'
        : item.state === 'Opened' || item.state === 'PR opened'
          ? 'waiting'
          : 'settled',
    ...(item.cornerId
      ? { onPress: () => onOpenCorner(item.cornerId!) }
      : item.url
        ? { onPress: () => onOpenUrl(item.url!) }
        : {}),
  }));
  const headline = formatNotificationHeadlines(run.items).join(' · ') || run.headline;
  return (
    <RepositoryFactCard
      title={!expanded && mergedTitle ? `${headline} · ${mergedTitle}` : headline}
      subline={isFoldedBatch && !expanded ? undefined : cardMeta(run.subline)}
      stamp={ledgerStamp(message.timestamp)}
      rows={rows}
      onHeaderPress={isFoldedBatch ? () => setExpanded((value) => !value) : undefined}
      headerExpanded={isFoldedBatch ? expanded : undefined}
      actions={
        isFoldedBatch && expanded
          ? [
              {
                label: 'Less',
                primary: true,
                onPress: () => setExpanded(false),
                testID: `notification-run-expand-${message.id}`,
              },
            ]
          : !isFoldedBatch && run.items.length > 3
            ? [
                {
                  label: expanded ? 'Less' : `${hiddenCount} more`,
                  primary: true,
                  onPress: () => setExpanded((value) => !value),
                  testID: `notification-run-expand-${message.id}`,
                },
              ]
          : []
      }
      testID={`notification-run-${message.id}`}
    />
  );
});

export const GitHubEventCard = React.memo(function GitHubEventCard({
  message,
  onOpenUrl,
}: GitHubEventCardProps) {
  const event = message.githubEvent!;
  const subject = event.type === 'pull-request' ? 'PR' : 'Issue';
  const state = event.action === 'merged' ? 'merged' : event.action;
  return (
    <RepositoryFactCard
      title={`${subject} 1 ${state}`}
      subline={event.actor ? cardMeta(`by @${event.actor.replace(/^@/, '')}`) : undefined}
      stamp={ledgerStamp(message.timestamp)}
      rows={[
        {
          id: message.id,
          state,
          title: event.title,
          kindLine: subject,
          tone: state === 'opened' ? 'waiting' : 'settled',
          onPress: () => onOpenUrl(event.url),
        },
      ]}
      actions={[
        {
          label: 'View ↗',
          primary: true,
          accessibilityRole: 'link',
          onPress: () => onOpenUrl(event.url),
          testID: `github-event-card-${event.type}-${event.action}-primary-action`,
        },
      ]}
      testID={`github-event-card-${event.type}-${event.action}`}
    />
  );
});

export interface DaemonFactCardProps {
  message: ChatDisplayMessage;
  reviewerHandle?: string;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}

export const DaemonFactCard = React.memo(function DaemonFactCard({
  message,
  reviewerHandle,
  onOpenCorner,
  onOpenUrl,
}: DaemonFactCardProps) {
  const fact = message.daemonFact!;
  const agent =
    message.authorIdentity?.kind === 'agent'
      ? (message.authorIdentity.handle ?? message.authorIdentity.name).replace(/^@/, '')
      : undefined;
  const landedCorner = fact.type === 'corner-complete' && fact.outcome === 'landed';
  // The NAME titles the card; the objective is its body. A card written
  // before the name existed falls back to the same three-word derivation
  // every other corner surface uses (C89).
  const title = cornerName(fact.name ?? fact.objective, fact.cornerId);
  const prNumber = fact.pullRequest?.number;
  const state = landedCorner
    ? 'merged'
    : fact.type === 'checks-failing'
      ? 'failed'
      : fact.type === 'corner-complete'
        ? 'closed'
        : fact.type === 'worktree-cleaned'
          ? 'closed'
          : undefined;
  const actions: TranscriptCardAction[] =
    fact.type === 'corner-complete' && fact.pullRequest
      ? [
          {
            label: 'Corner →',
            accessibilityRole: 'link',
            onPress: () => onOpenCorner(fact.cornerId),
            testID: 'corner-summary-card-secondary-action',
          },
          {
            label: 'View ↗',
            primary: true,
            accessibilityRole: 'link',
            onPress: () => onOpenUrl(fact.pullRequest!.url),
            testID: 'corner-summary-card-primary-action',
          },
        ]
      : [
          {
            label: 'Open →',
            primary: true,
            accessibilityRole: 'link',
            onPress: () => onOpenCorner(fact.cornerId),
            testID: `daemon-fact-card-${fact.type}-primary-action`,
          },
        ];
  return (
    <RepositoryFactCard
      title={landedCorner ? 'PR 1 merged' : title}
      subline={
        landedCorner && reviewerHandle
          ? cardMeta(`reviewer @${reviewerHandle}`)
          : fact.type === 'corner-open'
            ? cardMeta(`corner · opened by ${agent ? `@${agent}` : 'agent'}`)
            : undefined
      }
      stamp={ledgerStamp(message.timestamp)}
      body={fact.type === 'corner-open' ? fact.objective : undefined}
      rows={
        state
          ? [
              {
                id: message.id,
                state,
                title,
                kindLine: landedCorner
                  ? `corner${prNumber ? ` · PR #${prNumber}` : ''}`
                  : prNumber
                    ? `PR #${prNumber}`
                    : 'corner',
                tone: state === 'failed' ? 'failed' : 'settled',
              },
            ]
          : undefined
      }
      actions={actions}
      testID={landedCorner ? 'corner-summary-card' : `daemon-fact-card-${fact.type}`}
    />
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
function AttachmentCard({ attachment }: { attachment: AttachmentReference }) {
  const image =
    !attachment.expired && attachment.mimeType.startsWith('image/') && attachment.thumbnailUrl;
  const [mediaAuthorization, setMediaAuthorization] = useState<string>();
  useEffect(() => {
    if (!image || !getBuzzRuntimeConfig().monolithEnabled) return;
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
      accessibilityRole="link"
      onPress={open}
      style={styles.attachmentCard}
      testID={`chat-attachment-${attachment.name}`}
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
  onPress,
  onReply,
  onReact,
  onForward,
  reactedEmojis,
  isDesktop,
  replyOnly = false,
}: {
  children: React.ReactNode;
  messageId: string;
  onLongPress(): void;
  onPress?(): void;
  onReply(): void;
  onReact(emoji: MessageReactionEmoji): void;
  onForward(): void;
  reactedEmojis: ReadonlySet<MessageReactionEmoji>;
  isDesktop: boolean;
  replyOnly?: boolean;
}) {
  const swipeableRef = useRef<Swipeable | null>(null);
  const [desktopActionsVisible, setDesktopActionsVisible] = useState(false);
  const [reactionPickerVisible, setReactionPickerVisible] = useState(false);
  const nativeReactionPicker = Platform.OS !== 'web' && !replyOnly;
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
  ) : nativeReactionPicker ? (
    <Pressable
      accessibilityHint="Long press to react to this message"
      accessibilityLabel="Message"
      delayLongPress={350}
      onLongPress={() => setReactionPickerVisible(true)}
      onPress={onPress}
      testID={`message-touch-target-${messageId}`}
    >
      {children}
    </Pressable>
  ) : (
    <View onTouchEnd={onPress} testID={`copy-message-${messageId}`}>
      {children}
    </View>
  );
  if (isDesktop) {
    return (
      <View
        style={styles.replyDesktopRow}
        {...({
          onMouseEnter: () => setDesktopActionsVisible(true),
          onMouseLeave: () => setDesktopActionsVisible(false),
        } as any)}
      >
        {message}
        <View
          accessibilityLabel="Message actions"
          style={[
            styles.replyDesktopActions,
            desktopActionsVisible && styles.replyDesktopActionsVisible,
          ]}
          testID={`message-actions-${messageId}`}
        >
          {!replyOnly ? (
            <Pressable
              accessibilityLabel="Copy message text"
              accessibilityRole="button"
              onFocus={() => setDesktopActionsVisible(true)}
              onBlur={() => setDesktopActionsVisible(false)}
              onPress={onLongPress}
              style={({ pressed }) => [
                styles.replyDesktopAction,
                pressed && styles.replyDesktopPressed,
              ]}
              testID={`copy-button-${messageId}`}
            >
              <Text style={styles.replyDesktopGlyph}>⧉</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Reply to message"
            accessibilityRole="button"
            onFocus={() => setDesktopActionsVisible(true)}
            onBlur={() => setDesktopActionsVisible(false)}
            onPress={onReply}
            style={({ pressed }) => [
              styles.replyDesktopAction,
              pressed && styles.replyDesktopPressed,
            ]}
            testID={`reply-button-${messageId}`}
          >
            <Text style={styles.replyDesktopGlyph}>↩</Text>
          </Pressable>
          {!replyOnly ? (
            <>
              <Pressable
                accessibilityLabel="React to message"
                accessibilityRole="button"
                onFocus={() => setDesktopActionsVisible(true)}
                onPress={() => setReactionPickerVisible((visible) => !visible)}
                style={({ pressed }) => [
                  styles.replyDesktopAction,
                  pressed && styles.replyDesktopPressed,
                ]}
                testID={`react-button-${messageId}`}
              >
                <Text style={styles.replyDesktopGlyph}>☺</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Forward message"
                accessibilityRole="button"
                onFocus={() => setDesktopActionsVisible(true)}
                onPress={onForward}
                style={({ pressed }) => [
                  styles.replyDesktopAction,
                  pressed && styles.replyDesktopPressed,
                ]}
                testID={`forward-button-${messageId}`}
              >
                <Text style={styles.replyDesktopGlyph}>↗</Text>
              </Pressable>
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
  return (
    <>
      <Swipeable
        ref={swipeableRef}
        // Swipeable's container clips (`overflow: 'hidden'`) at the row's content
        // edge, where the byline tile sits — and a live agent's gold ring paints
        // `ALIVE_RING_PAD` outside that tile. The clip box is outset by the ring
        // gutter and the children padded back by the same amount, so the copy
        // column never moves and the whole tile, ring included, stays visible.
        containerStyle={styles.replySwipeContainer}
        childrenContainerStyle={styles.replySwipeChildren}
        dragOffsetFromRightEdge={18}
        friction={1.35}
        onSwipeableOpen={(direction) => {
          if (direction !== 'right') return;
          swipeableRef.current?.close();
          onReply();
        }}
        overshootRight={false}
        renderRightActions={() => (
          <View
            accessibilityLabel="Reply to message"
            style={styles.replySwipeAction}
            testID={`reply-swipe-action-${messageId}`}
          >
            <Text style={styles.replySwipeGlyph}>↩</Text>
            <Text style={styles.replySwipeLabel}>REPLY</Text>
          </View>
        )}
        testID={`swipe-reply-${messageId}`}
      >
        {message}
      </Swipeable>
      {nativeReactionPicker ? (
        <HullActionSheetModal
          accessibilityLabel="Dismiss reaction picker"
          modalTestID={`reaction-picker-${messageId}`}
          onClose={() => setReactionPickerVisible(false)}
          scrimTestID={`reaction-picker-dismiss-${messageId}`}
          testID={`reaction-picker-sheet-${messageId}`}
          title="React to message"
          visible={reactionPickerVisible}
        >
          <View style={styles.nativeReactionChoices}>
            {MESSAGE_REACTION_EMOJIS.map((emoji) => (
              <Pressable
                accessibilityLabel={`Toggle ${emoji} reaction`}
                accessibilityRole="button"
                accessibilityState={{ selected: reactedEmojis.has(emoji) }}
                key={emoji}
                onPress={() => {
                  onReact(emoji);
                  setReactionPickerVisible(false);
                }}
                style={({ pressed }) => [
                  styles.nativeReactionChoice,
                  reactedEmojis.has(emoji) && styles.nativeReactionChoiceSelected,
                  pressed && styles.replyDesktopPressed,
                ]}
                testID={`reaction-choice-${messageId}-${emoji}`}
              >
                <Text style={styles.nativeReactionEmoji}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
        </HullActionSheetModal>
      ) : null}
    </>
  );
}

/** Relays have no speaker tile, bubble, reply swipe, or self-message treatment. */
export function RelayHandOff({ message }: { message: ChatDisplayMessage }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const measure = useRef<Text>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || !measure.current) return;
    const element = measure.current as unknown as HTMLElement;
    const update = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflows(element.getBoundingClientRect().height > lineHeight * 2 + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [message.text]);
  const relay = message.relay!;
  const caption =
    relay.direction === 'down'
      ? `FROM #${relay.fromName.replace(/^#/, '')}`
      : `FROM THE CORNER · ${relay.fromName}`;
  return (
    <View style={styles.relay} testID={`relay-${message.id}`}>
      <Text style={styles.relayCaption}>
        {caption}
        {message.authorIdentity?.handle
          ? ` · @${message.authorIdentity.handle.replace(/^@/, '')}`
          : ''}
      </Text>
      <View>
        <Text
          style={styles.relayText}
          numberOfLines={expanded ? undefined : 2}
          testID={`relay-text-${message.id}`}
        >
          {message.text}
        </Text>
        <Text
          ref={measure}
          style={[styles.relayText, styles.relayMeasure]}
          accessible={false}
          aria-hidden
          pointerEvents="none"
          testID={`relay-measure-${message.id}`}
          onTextLayout={(event) => setOverflows(event.nativeEvent.lines.length > 2)}
        >
          {message.text}
        </Text>
      </View>
      {overflows ? (
        <Pressable
          onPress={() => setExpanded(!expanded)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show less relay text' : 'Show more relay text'}
          accessibilityState={{ expanded }}
          testID={`relay-toggle-${message.id}`}
        >
          <Text style={styles.relayToggle}>{expanded ? 'LESS' : 'MORE'}</Text>
        </Pressable>
      ) : null}
      {relay.direction === 'down' && relay.received ? (
        <Text style={styles.relayCaption}>RECEIVED</Text>
      ) : null}
    </View>
  );
}

export interface OrdinaryLedgerMessageProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  participantsHydrated: boolean;
  personName?: string;
  viewerPubkey: string;
  /**
   * The speaker is WORKING right now — a fresh working receipt or a live
   * corner (`selectWorkingAgents`). Lights the byline's gold ring. Never the
   * delivery availability: an available daemon may not be working yet (C77).
   */
  speakerWorking: boolean;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedTarget?: MessageReplyDisplayTarget;
  participantHandles: readonly { pubkey: string; handle: string }[];
  channelIndex: ChannelReferenceIndex;
  deliveryFailed: boolean;
  onChannelReference(target: ChannelReferenceTarget): void;
  onMention?(participantId: string): void;
  /** A tap on the row — the composer's "outside" — puts the keyboard away. */
  onTapOutsideComposer?(): void;
  onReply(message: ChatDisplayMessage): void;
  onCopy(text: string): void;
  onReact?(message: ChatDisplayMessage, emoji: MessageReactionEmoji): void;
  onForward?(message: ChatDisplayMessage): void;
  onRetry(eventId: string): void;
  onDismiss(eventId: string): void;
  /** Read-only @system DMs are a full-width announcement feed, not a chat. */
  announcementFeed?: boolean;
  desktopLayout?: boolean;
}

export const OrdinaryLedgerMessage = React.memo(function OrdinaryLedgerMessage({
  message,
  agent,
  participantsHydrated,
  personName,
  viewerPubkey,
  speakerWorking,
  continued,
  immediatelyPrecedingMessage,
  referencedTarget,
  participantHandles,
  channelIndex,
  deliveryFailed,
  onChannelReference,
  onMention,
  onTapOutsideComposer,
  onReply,
  onCopy,
  onReact = () => undefined,
  onForward = () => undefined,
  onRetry,
  onDismiss,
  announcementFeed = false,
  desktopLayout = false,
}: OrdinaryLedgerMessageProps) {
  const isOwn = message.isUser;
  const indexedAuthor = message.authorIdentity;
  const speakerFace = indexedAuthor?.face ?? agent?.face;
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
  const display = isAgent
    ? resolvePendingAgentDisplay(
        message.pubkey ?? indexedAuthor?.pubkey ?? 'unknown-agent',
        currentAgent,
        participantsHydrated,
      )
    : null;
  const isSelfSteer = isOwn && !isAgent;
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
    continued && !isAgent && !announcementFeed
      ? undefined
      : {
          name: isSelfSteer ? 'You' : voiceName,
          role: isAgent ? 'agent' : undefined,
          stamp: ledgerStamp(message.timestamp),
          isViewer: isSelfSteer,
          ...(announcementFeed
            ? {}
            : {
                mark: {
                  seed: markSeed,
                  kind: isAgent ? ('agent' as const) : ('human' as const),
                  ...(speakerFace ? { face: speakerFace } : {}),
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
    message.pubkey && message.agentMessageDraft ? draftRequestId(message.id) : undefined;
  useEffect(() => {
    if (!draftKey || !message.pubkey || !message.agentMessageDraft) return;
    rememberProvisionalDraft(
      provisionalDraftKey(message.pubkey, draftKey),
      message.agentMessageDraft,
    );
  }, [draftKey, message.agentMessageDraft, message.pubkey]);
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
  const mentionHandles = useMemo(
    () =>
      participantHandles
        .filter((participant) => taggedMentionPubkeys.has(participant.pubkey))
        .map((participant) => participant.handle),
    [participantHandles, taggedMentionPubkeys],
  );
  const handleMention = useCallback(
    (handle: string) => {
      const participant = participantHandles.find(
        (candidate) =>
          candidate.pubkey !== viewerPubkey &&
          taggedMentionPubkeys.has(candidate.pubkey) &&
          candidate.handle.normalize('NFKC').toLocaleLowerCase() === handle,
      );
      if (participant) onMention?.(participant.pubkey);
    },
    [onMention, participantHandles, taggedMentionPubkeys, viewerPubkey],
  );
  if (message.isAgentActivity) {
    const excerpt = agentActivityReplyExcerpt(message);
    return (
      <View style={styles.activityGroup} testID="corner-activity">
        <SwipeToReply
          messageId={message.id}
          onLongPress={() => onCopy(excerpt)}
          {...(onTapOutsideComposer ? { onPress: onTapOutsideComposer } : {})}
          onReply={() => onReply(message)}
          onReact={() => undefined}
          onForward={() => undefined}
          reactedEmojis={new Set()}
          isDesktop={desktopLayout}
          replyOnly
        >
          <ActivityTimeline
            active={message.isAgentLiveTurn === true}
            handle={!continued && isAgent ? voiceName : undefined}
            mark={
              !continued && isAgent
                ? {
                    seed: markSeed,
                    kind: 'agent',
                    // Same axes the settled byline mark renders (its creature,
                    // and working → gold ring): the streaming lane is the same
                    // speaker, so it must not wear a different animal for the
                    // length of the turn.
                    ...(speakerFace ? { face: speakerFace } : {}),
                    alive: message.isAgentLiveTurn === true,
                  }
                : undefined
            }
            items={activity}
            messageDraft={message.agentMessageDraft}
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
  const replyReference = showReplyReference ? (
    <View style={styles.replyReference} testID={`reply-reference-${message.id}`}>
      <Text numberOfLines={2} style={styles.replyReferenceText}>
        ↳ {referencedTarget?.authorName ?? 'ORIGINAL MESSAGE'} ·{' '}
        {referencedTarget?.preview ?? 'Message not loaded'}
      </Text>
    </View>
  ) : null;
  const forwarded = forwardedMessageParts(message.text);
  const ledgerText = isSelfSteer ? undefined : splitLedgerText(forwarded.body);
  const machineNoise = ledgerText?.machine ? (
    <LedgerGhostLine
      body={ledgerText.machine}
      label={`${ledgerText.machineLines} lines of tool output`}
      testID={`chat-machine-noise-${message.id}`}
    />
  ) : null;
  const attachments = message.attachments?.map((attachment) => (
    <AttachmentCard attachment={attachment} key={`${message.id}-${attachment.url}`} />
  ));

  const content = (
    <NewMessageMaterialize enabled={Boolean(message.isNew)} messageId={message.id}>
      <View>
        {isSelfSteer ? (
          <LedgerSteer
            itemId={message.id}
            continued={continued}
            byline={byline}
            bodyText={forwarded.body}
            mentionHandles={mentionHandles}
            onMention={handleMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            bodyTestID={`chat-message-text-${message.id}`}
            replyReference={replyReference}
            attachments={attachments}
          />
        ) : (
          <LedgerEntry
            itemId={message.id}
            byline={byline}
            continued={continued}
            luminous={isAgent && !announcementFeed}
            typewriter={isAgent && !announcementFeed && Boolean(message.isNew)}
            settleFrom={settleFrom}
            bodyText={ledgerText ? ledgerText.prose : forwarded.body}
            mentionHandles={mentionHandles}
            onMention={handleMention}
            channelIndex={channelIndex}
            onChannelReference={onChannelReference}
            bodyTestID={`chat-message-text-${message.id}`}
            replyReference={replyReference}
            machineNoise={machineNoise}
            attachments={attachments}
          />
        )}
        {forwarded.caption ? (
          <Text style={styles.forwardCaption} testID={`forward-caption-${message.id}`}>
            {forwarded.caption}
          </Text>
        ) : null}
        {message.isUser && deliveryFailed ? (
          <View style={styles.outboxFailure} testID={`outbox-delivery-failed-${message.id}`}>
            <Text style={styles.outboxFailureText}>DELIVERY FAILED</Text>
            <View style={styles.outboxFailureActions}>
              <MonoButton label="RETRY" onPress={() => onRetry(message.id)} variant="secondary" />
              <MonoButton
                label="DISMISS"
                onPress={() => onDismiss(message.id)}
                variant="secondary"
              />
            </View>
          </View>
        ) : null}
        {message.reactions?.length ? (
          <View style={styles.reactionChips} testID={`reaction-chips-${message.id}`}>
            {message.reactions.map((reaction) => (
              <Pressable
                accessibilityLabel={`${reaction.emoji}, ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
                accessibilityRole="button"
                accessibilityState={{ selected: reaction.reacted }}
                key={reaction.emoji}
                onPress={() => onReact(message, reaction.emoji)}
                style={[styles.reactionChip, reaction.reacted && styles.reactionChipMine]}
                testID={`reaction-chip-${message.id}-${reaction.emoji}`}
              >
                <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
                <Text style={styles.reactionCount}>{reaction.count}</Text>
              </Pressable>
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
      {...(onTapOutsideComposer ? { onPress: onTapOutsideComposer } : {})}
      onReply={message.isAgentDraft ? () => undefined : () => onReply(message)}
      onReact={(emoji) => onReact(message, emoji)}
      onForward={() => onForward(message)}
      reactedEmojis={
        new Set(
          message.reactions
            ?.filter((reaction) => reaction.reacted)
            .map((reaction) => reaction.emoji),
        )
      }
      isDesktop={desktopLayout}
    >
      {content}
    </SwipeToReply>
  );
});

const styles = StyleSheet.create((theme) => ({
  relay: { paddingVertical: 12, gap: 6 },
  relayCaption: { ...groknight.type.sectionHead, color: groknight.textSecondary },
  relayText: { ...groknight.type.body, color: groknight.textSecondary },
  relayToggle: { ...groknight.type.sectionHead, color: groknight.accent },
  relayMeasure: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 },
  activityGroup: { width: '100%', minWidth: 0, marginBottom: 20 },
  replyReference: { minWidth: 0, marginBottom: 5 },
  replyReferenceText: {
    ...Typography.mono(),
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 17,
  },
  outboxFailure: {
    marginTop: 4,
    marginHorizontal: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  outboxFailureText: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 9,
    letterSpacing: 0.5,
  },
  outboxFailureActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  replySwipeContainer: { marginHorizontal: -ALIVE_RING_PAD },
  replySwipeChildren: { paddingHorizontal: ALIVE_RING_PAD },
  replyDesktopRow: { position: 'relative', flexDirection: 'row', alignItems: 'flex-start' },
  replyDesktopMessage: { flex: 1, minWidth: 0 },
  replyDesktopActions: {
    position: 'absolute',
    top: 0,
    right: 0,
    flexDirection: 'row',
    opacity: 0,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: groknight.radius,
    backgroundColor: groknight.bgTerminal,
  },
  replyDesktopActionsVisible: { opacity: 1 },
  replyDesktopAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replyDesktopPressed: { backgroundColor: groknight.bgHighlight },
  replyDesktopGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0,
  },
  reactionPicker: {
    position: 'absolute',
    top: 46,
    right: 0,
    zIndex: 4,
    flexDirection: 'row',
    padding: 4,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: groknight.radius,
    backgroundColor: groknight.bgTerminal,
  },
  reactionPickerChoice: {
    width: 36,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeReactionChoices: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  nativeReactionChoice: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: groknight.radius,
  },
  nativeReactionChoiceSelected: {
    borderColor: groknight.accent,
    backgroundColor: groknight.bgHighlight,
  },
  nativeReactionEmoji: { ...theme.buzz.type.body, fontSize: 24, lineHeight: 30 },
  reactionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
    marginLeft: 8,
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: groknight.radius,
    backgroundColor: groknight.bgBase,
  },
  reactionChipMine: {
    borderColor: groknight.accent,
    backgroundColor: groknight.bgHighlight,
  },
  reactionEmoji: { ...theme.buzz.type.body, lineHeight: 19 },
  reactionCount: {
    ...groknight.type.meta,
    color: groknight.textSecondary,
  },
  forwardCaption: {
    ...groknight.type.sectionHead,
    marginTop: 5,
    marginLeft: 8,
    color: groknight.ledgerQuiet,
  },
  replyDesktopLabel: {
    ...Typography.default('semiBold'),
    marginTop: 1,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 2,
  },
  replySwipeAction: {
    width: 78,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  replySwipeGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 17,
    lineHeight: 20,
  },
  replySwipeLabel: {
    ...Typography.mono('semiBold'),
    marginTop: 2,
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
    letterSpacing: 0.6,
  },
  attachmentCard: {
    minWidth: 0,
    width: '100%',
    minHeight: 58,
    marginTop: 8,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  attachmentThumbnail: { width: 46, height: 46, backgroundColor: groknight.bgHighlight },
  attachmentFileGlyph: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  attachmentFileGlyphText: { ...Typography.default(), color: groknight.steel, fontSize: 20 },
  attachmentCopy: { flex: 1, minWidth: 0 },
  attachmentExpired: { color: groknight.textMuted },
  attachmentName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 16,
  },
  attachmentMeta: {
    ...Typography.mono(),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
  },
  attachmentOpenGlyph: {
    ...Typography.default(),
    width: 22,
    color: groknight.steel,
    fontSize: 14,
    textAlign: 'center',
  },
}));
