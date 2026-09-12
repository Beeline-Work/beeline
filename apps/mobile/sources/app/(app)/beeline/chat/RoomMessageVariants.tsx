import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import {
  MESSAGE_REACTION_EMOJIS,
  type AttachmentReference,
  type MessageReactionEmoji,
} from '@beeline/buzz-client';

import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import type { MessageReplyDisplayTarget } from '@/buzz/message-reply';
import { resolveAgentDisplayIdentity, resolvePendingAgentDisplay } from '@/buzz/agent-display';
import { fallbackMemberName } from '@/buzz/member-display';
import { describeWriteRequest } from '@/buzz/write-request-copy';
import { grantAskLine, grantOutcomeLine } from '@/buzz/agent-grant-copy';
import { shouldShowReplyReference } from '@/buzz/reply-reference';
import {
  draftRequestId,
  provisionalDraftKey,
  rememberProvisionalDraft,
  takeProvisionalDraft,
} from '@/buzz/draft-settle';
import { splitLedgerText } from '@/buzz/ledger-text';
import { ledgerStamp } from '@/buzz/relative-time';
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
import { HullSurface, MonoButton, NewMessageMaterialize } from '@/components/buzz/MonoHull';
import { WritePermissionOutcome } from '@/components/buzz/WritePermissionOutcome';
import { forwardedMessageParts } from '@/buzz/message-forward';

type WriteDecision = 'allow' | 'deny';

export interface WritePermissionCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  viewerRole: 'owner' | 'admin' | 'member' | null;
  actionId: string | null;
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
  return (
    <HullSurface
      strength="raised"
      style={styles.permissionCard}
      testID={`write-permission-${permission.status}`}
    >
      <View style={styles.permissionHeading}>
        <IdentityMark
          kind="agent"
          seed={display.avatarSeed ?? permission.agentPubkey}
          avatarUrl={display.avatarUrl}
          face={display.face}
          name={display.name}
          size={30}
        />
        <View style={styles.permissionCopy}>
          <Text style={styles.permissionTitle}>
            {squireSpending
              ? `${display.name} requests owner confirmation`
              : permission.repository
                ? `${display.name} requests a new edit corner`
                : `${display.name} needs to change repository files`}
          </Text>
          <Text style={styles.permissionIntent} numberOfLines={2}>
            {describeWriteRequest(permission.tool)}
          </Text>
        </View>
      </View>
      {permission.repository && !squireSpending ? (
        <Text style={styles.permissionRepository} testID="write-permission-repository">
          EDIT CORNER ON {permission.repository}
        </Text>
      ) : null}
      <Text style={styles.permissionBoundary}>
        {squireSpending
          ? 'Trusty Squire stays in its vault-backed process. Only the Room owner can confirm this spending or checkout-capable action.'
          : permission.repository
            ? `The write is refused here. Allowing grants isolated edit access to exactly ${permission.repository}; merge authority stays human-only.`
            : 'This write request is missing its repository target and cannot be allowed.'}
      </Text>
      {permission.status === 'failed' ? (
        <Text style={styles.permissionFailure}>
          The requested edit could not start. This Room remains read-only.
        </Text>
      ) : null}
      {pending &&
      canDecide &&
      permission.repository &&
      (!squireSpending || viewerRole === 'owner') ? (
        <View style={styles.permissionActions}>
          <MonoButton
            label="Deny"
            variant="secondary"
            disabled={busy}
            onPress={() => onDecision(message, 'deny')}
            style={styles.permissionButton}
          />
          <MonoButton
            label={squireSpending ? 'Confirm Squire action' : 'Open edit corner'}
            loading={busy}
            onPress={() => onDecision(message, 'allow')}
            style={styles.permissionButton}
          />
        </View>
      ) : pending && !viewerIsAgent && squireSpending ? (
        <Text style={styles.permissionStatus}>ROOM OWNER CONFIRMATION REQUIRED</Text>
      ) : pending && !viewerIsAgent && permission.repository && !canDecide ? (
        <Text style={styles.permissionStatus} testID="corner-approval-audience-wait">
          REQUESTER OR ROOM ADMIN APPROVAL REQUIRED
        </Text>
      ) : pending && !viewerIsAgent ? (
        <Text style={styles.permissionStatus}>MISSING TARGET · CANNOT APPROVE</Text>
      ) : (
        <WritePermissionOutcome
          status={permission.status}
          subchannelId={permission.subchannelId}
          awaitingPerson={viewerIsAgent && pending}
          onOpen={
            permission.subchannelId ? () => onOpenCorner(permission.subchannelId!) : undefined
          }
        />
      )}
    </HullSurface>
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
    <HullSurface
      strength="raised"
      style={styles.permissionCard}
      testID={`grant-request-${anyPending ? 'pending' : 'settled'}`}
    >
      <View style={styles.permissionHeading}>
        <IdentityMark
          kind="agent"
          seed={display.avatarSeed ?? request.agent.pubkey}
          avatarUrl={display.avatarUrl}
          face={display.face}
          name={agentName}
          size={30}
        />
        <View style={styles.permissionCopy}>
          <Text style={styles.permissionTitle} testID="grant-request-title">
            {agentName} asks {request.owner.name}
          </Text>
          {request.requester.pubkey !== request.owner.pubkey ? (
            <Text style={styles.permissionIntent} numberOfLines={1}>
              at {request.requester.name}’s request
            </Text>
          ) : null}
        </View>
      </View>
      {request.grants.map((grant) => {
        const busy = actionId === grant.grantId;
        const outcome = grantOutcomeLine(grant);
        return (
          <View key={grant.grantId} style={styles.grantLine} testID={`grant-${grant.grantId}`}>
            <Text style={styles.grantAsk} testID={`grant-${grant.grantId}-ask`}>
              {grantAskLine(grant)}
            </Text>
            <Text style={styles.permissionIntent}>{grant.reason}</Text>
            {grant.script ? (
              <View style={styles.grantScript} testID={`grant-${grant.grantId}-script`}>
                <Text style={styles.grantScriptPath}>{grant.script.path}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={styles.grantScriptBody}>{grant.script.contents}</Text>
                </ScrollView>
              </View>
            ) : null}
            {grant.status === 'pending' && canDecide ? (
              <View style={styles.permissionActions}>
                <MonoButton
                  label="ALWAYS"
                  loading={busy}
                  disabled={actionId !== null}
                  onPress={() => onDecision(grant.grantId, 'always')}
                  style={styles.permissionButton}
                  testID={`grant-${grant.grantId}-always`}
                />
                <MonoButton
                  label="ONCE"
                  variant="secondary"
                  disabled={actionId !== null}
                  onPress={() => onDecision(grant.grantId, 'once')}
                  style={styles.permissionButton}
                  testID={`grant-${grant.grantId}-once`}
                />
                <MonoButton
                  label="NO"
                  variant="secondary"
                  disabled={actionId !== null}
                  onPress={() => onDecision(grant.grantId, 'deny')}
                  style={styles.permissionButton}
                  testID={`grant-${grant.grantId}-deny`}
                />
              </View>
            ) : grant.status === 'pending' ? (
              <Text style={styles.permissionStatus} testID={`grant-${grant.grantId}-waiting`}>
                WAITING FOR {request.owner.name.toUpperCase()}
              </Text>
            ) : (
              <WritePermissionOutcome
                status={grant.status === 'denied' ? 'denied' : 'allowed'}
                label={outcome ?? undefined}
                testID={`grant-${grant.grantId}-outcome`}
              />
            )}
          </View>
        );
      })}
    </HullSurface>
  );
});

export interface TargetBranchProposalCardProps {
  message: ChatDisplayMessage;
  currentTargetBranch?: string;
  canManageWorkspace: boolean;
  viewerIsAgent: boolean;
  actionId: string | null;
  notice: string | null;
  onConfirm(message: ChatDisplayMessage): void;
}

export const TargetBranchProposalCard = React.memo(function TargetBranchProposalCard({
  message,
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
  return (
    <HullSurface strength="raised" style={styles.targetCard} testID="target-branch-proposal">
      <Text style={styles.targetTitle}>Change this {ROOM_LABEL}’s target branch</Text>
      <Text style={styles.targetChange} testID="target-branch-change">
        {proposal.from} → {proposal.to}
      </Text>
      <Text style={styles.targetBoundary}>
        {`Confirming republishes this ${ROOM_LABEL}'s repository binding under your key. ` +
          `${CORNER_LABEL}s already open automatically rebase onto ${proposal.to}; any conflict appears in their activity ledger for the agent to resolve.`}
      </Text>
      {applied ? (
        <Text style={styles.targetStatus} testID="target-branch-applied">
          ✓ TARGET BRANCH IS NOW {proposal.to.toUpperCase()}
        </Text>
      ) : canConfirm ? (
        <View style={styles.targetActions}>
          <MonoButton
            label={`Confirm ${proposal.to}`}
            loading={busy}
            disabled={busy}
            onPress={() => onConfirm(message)}
            style={styles.targetButton}
            testID="target-branch-confirm"
          />
        </View>
      ) : (
        <Text style={styles.targetStatus} testID="target-branch-denied">
          {'ONLY A WORKSPACE MANAGER CAN CONFIRM THIS'}
        </Text>
      )}
      {notice ? (
        <Text style={styles.targetStatus} testID="target-branch-notice">
          {notice}
        </Text>
      ) : null}
    </HullSurface>
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
  title: string;
  body?: string;
  actionLabel: string;
  onPress(): void;
  testID: string;
  secondaryActionLabel?: string;
  onSecondaryPress?(): void;
};

/** Shared visual shell for verified GitHub events and daemon lifecycle facts. */
const RepositoryFactCard = React.memo(function RepositoryFactCard({
  title,
  body,
  actionLabel,
  onPress,
  testID,
  secondaryActionLabel,
  onSecondaryPress,
}: RepositoryFactCardProps) {
  return (
    <View style={styles.githubPressable} testID={testID}>
      <HullSurface strength="raised" style={styles.githubCard}>
        <Text style={styles.githubTitle}>{title}</Text>
        {body ? <Text style={styles.githubBody}>{body}</Text> : null}
        <View style={styles.githubActions}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={actionLabel}
            onPress={onPress}
            testID={`${testID}-primary-action`}
          >
            <Text style={styles.githubLink}>{actionLabel}</Text>
          </Pressable>
          {secondaryActionLabel && onSecondaryPress ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={secondaryActionLabel}
              onPress={onSecondaryPress}
              testID={`${testID}-secondary-action`}
            >
              <Text style={styles.githubLink}>{secondaryActionLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </HullSurface>
    </View>
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
  const visibleItems = expanded ? run.items : run.items.slice(0, 3);
  return (
    <View style={styles.githubPressable} testID={`notification-run-${message.id}`}>
      <HullSurface strength="raised" style={styles.githubCard}>
        <Text style={styles.githubTitle}>{run.headline}</Text>
        <Text style={styles.notificationRunSubline}>{run.subline}</Text>
        <View style={styles.notificationRunItems}>
          {visibleItems.map((item) => {
            const onPress = item.cornerId
              ? () => onOpenCorner(item.cornerId!)
              : item.url
                ? () => onOpenUrl(item.url!)
                : undefined;
            return (
              <Pressable
                key={item.id}
                accessibilityRole={onPress ? 'link' : undefined}
                accessibilityLabel={`${item.state}: ${item.title}. ${item.kindLine}`}
                disabled={!onPress}
                onPress={onPress}
                style={styles.notificationRunItem}
                testID={`notification-run-item-${item.id}`}
              >
                <Text
                  style={
                    item.danger ? styles.notificationRunStateDanger : styles.notificationRunState
                  }
                >
                  {item.danger ? `${item.state} ×` : item.state}
                </Text>
                <View style={styles.notificationRunCopy}>
                  <Text numberOfLines={1} style={styles.notificationRunTitle}>
                    {item.title}
                  </Text>
                  <Text style={styles.notificationRunKind}>{item.kindLine}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        {run.items.length > 3 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              expanded
                ? 'Show fewer notifications'
                : `Show ${run.items.length - 3} more notifications`
            }
            onPress={() => setExpanded((value) => !value)}
            testID={`notification-run-expand-${message.id}`}
          >
            <Text style={styles.notificationRunMore}>
              {expanded ? 'show less' : `and ${run.items.length - 3} more`}
            </Text>
          </Pressable>
        ) : null}
      </HullSurface>
    </View>
  );
});

export const GitHubEventCard = React.memo(function GitHubEventCard({
  message,
  onOpenUrl,
}: GitHubEventCardProps) {
  const event = message.githubEvent!;
  const title =
    event.type === 'pull-request'
      ? event.action === 'opened'
        ? `${event.actor} created a new PR: ${event.title}`
        : event.action === 'merged'
          ? `${event.actor} merged a PR: ${event.title}`
          : `${event.actor} closed a PR: ${event.title}`
      : event.action === 'opened'
        ? `${event.actor} created a new issue: ${event.title}`
        : `${event.actor} closed an issue: ${event.title}`;
  return (
    <RepositoryFactCard
      title={title}
      actionLabel="VIEW ON GITHUB ↗"
      onPress={() => onOpenUrl(event.url)}
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
  const body =
    fact.type === 'corner-complete'
      ? landedCorner
        ? `${reviewerHandle ? `Reviewer: @${reviewerHandle}\n` : ''}${fact.objective}`
        : 'ABANDONED · Remote branch deleted'
      : fact.type === 'checks-failing'
        ? `CHECKS FAILING${fact.pullRequest ? ` · PR #${fact.pullRequest.number ?? ''}` : ''}`
        : fact.type === 'corner-open'
          ? // Opened by, not owned by: every member agent can be addressed in
            // the corner and carry its branch on.
            `${agent ? `OPENED BY ${agent}\n` : ''}${fact.objective}`
          : 'WORKTREE CLEANED';
  return (
    <RepositoryFactCard
      title={landedCorner ? `Merged ${title}${agent ? ` by @${agent}` : ''}` : title}
      body={body}
      actionLabel={
        fact.type === 'corner-complete' && fact.pullRequest
          ? `VIEW PR: ${fact.pullRequest.title ?? 'PULL REQUEST'} ↗`
          : 'OPEN CORNER →'
      }
      onPress={() =>
        fact.type === 'corner-complete' && fact.pullRequest
          ? onOpenUrl(fact.pullRequest.url)
          : onOpenCorner(fact.cornerId)
      }
      {...(fact.type === 'corner-complete' && fact.pullRequest
        ? {
            secondaryActionLabel: 'OPEN ARCHIVED CORNER →',
            onSecondaryPress: () => onOpenCorner(fact.cornerId),
          }
        : {})}
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
  isDesktop,
}: {
  children: React.ReactNode;
  messageId: string;
  onLongPress(): void;
  onPress?(): void;
  onReply(): void;
  onReact(emoji: MessageReactionEmoji): void;
  onForward(): void;
  isDesktop: boolean;
}) {
  const swipeableRef = useRef<Swipeable | null>(null);
  const [desktopActionsVisible, setDesktopActionsVisible] = useState(false);
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
        </View>
        {reactionPickerVisible ? (
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
    return (
      <View style={styles.activityGroup} testID="corner-activity">
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
      isDesktop={desktopLayout}
    >
      {content}
    </SwipeToReply>
  );
});

const styles = StyleSheet.create(() => ({
  permissionCard: {
    minWidth: 0,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    gap: 10,
  },
  permissionHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  permissionCopy: { flex: 1, minWidth: 0 },
  permissionTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  permissionIntent: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  permissionRepository: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.35,
  },
  permissionBoundary: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  permissionFailure: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  permissionActions: { flexDirection: 'row', gap: 8 },
  permissionButton: { flex: 1, minWidth: 0 },
  grantLine: { gap: 6 },
  // C94: an interpreter grant is approved on its BODY, not on its command line,
  // so the card inscribes the script itself in the machine role.
  grantScript: {
    gap: 4,
    paddingVertical: 8,
    paddingLeft: 10,
    borderLeftWidth: 1,
    borderLeftColor: groknight.borderStrong,
  },
  grantScriptPath: {
    ...Typography.mono('regular'),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  grantScriptBody: {
    ...Typography.mono('regular'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  grantAsk: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 17,
  },
  permissionStatus: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 14,
    letterSpacing: 0.5,
  },
  targetCard: {
    minWidth: 0,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    gap: 8,
  },
  targetTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  targetChange: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 0.35,
  },
  targetBoundary: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  targetActions: { flexDirection: 'row', gap: 8 },
  targetButton: { flex: 1, minWidth: 0 },
  targetStatus: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 14,
    letterSpacing: 0.5,
  },
  githubPressable: { marginBottom: 8 },
  githubCard: {
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    gap: 6,
  },
  githubTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 19,
  },
  githubBody: {
    ...Typography.default('regular'),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  githubLink: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.45,
  },
  githubActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  notificationRunSubline: {
    ...groknight.type.meta,
    color: groknight.textSecondary,
  },
  notificationRunItems: { gap: 8, marginTop: 2 },
  notificationRunItem: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
    minWidth: 0,
  },
  notificationRunState: {
    ...groknight.type.sectionHead,
    color: groknight.textSecondary,
    width: 102,
  },
  notificationRunStateDanger: {
    ...groknight.type.sectionHead,
    color: groknight.danger,
    width: 102,
  },
  notificationRunCopy: { flex: 1, minWidth: 0 },
  notificationRunTitle: {
    ...groknight.type.meta,
    fontFamily: groknight.proseSemibold,
    color: groknight.textPrimary,
    textDecorationLine: 'underline',
    textDecorationColor: groknight.borderStrong,
  },
  notificationRunKind: {
    ...groknight.type.meta,
    color: groknight.ledgerQuiet,
  },
  notificationRunMore: {
    ...groknight.type.sectionHead,
    color: groknight.accent,
    marginTop: 2,
  },
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
  reactionEmoji: { fontSize: 15, lineHeight: 19 },
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
