import React from 'react';
import { Text, View } from 'react-native';
import { AGENT_GRANT_VERBS, grantPresentation } from '@beeline/api-contract/agent-grants';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { ledgerStamp } from '@/buzz/relative-time';
import { AgentApprovalCard, approvalAudience, approvalDecisionNote } from './AgentApprovalCard';
import { type TranscriptCardAction } from './TranscriptCard';

export type GrantDecision = 'always' | 'once' | 'deny';

export interface GrantRequestCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  /** The server's Workspace owner/admin decision (`viewer.permissions.manage`). */
  viewerCanManageWorkspace?: boolean;
  actionId: string | null;
  onDecision(grantId: string, decision: GrantDecision): void;
  onOpenSource?(roomId: string, messageId: string): void;
}

/** One grant request across DMs, Rooms, System, web and desktop. */
export const GrantRequestCard = React.memo(function GrantRequestCard({
  message,
  agent,
  viewerIsAgent,
  viewerPubkey,
  viewerCanManageWorkspace = false,
  actionId,
  onDecision,
  onOpenSource,
}: GrantRequestCardProps) {
  const request = message.grantRequest!;
  const display = resolveAgentDisplayIdentity(request.agent.pubkey, agent);
  // The server names the asking agent on the card; a loaded roster presentation
  // (soul name) wins once it exists, never a fallback placeholder.
  const agentName = agent ? display.name : request.agent.name;
  const repositoryRequest = request.grants.every((grant) => grant.kind === 'repository');
  const sharedAssetRequest = request.grants.every((grant) => grant.kind === 'shared_asset');
  const canDecide =
    !viewerIsAgent &&
    (repositoryRequest
      ? viewerCanManageWorkspace
      : sharedAssetRequest
        ? viewerCanManageWorkspace || viewerPubkey === request.owner.pubkey
      : viewerPubkey === request.owner.pubkey);
  const anyPending = request.grants.some((grant) => grant.status === 'pending');
  return (
    <View testID={`grant-request-${anyPending ? 'pending' : 'settled'}`}>
      {request.grants.map((grant) => {
        const script = grant.script?.contents ?? (grant.kind === 'command' ? grant.target : undefined);
        const { purpose, facts } = grantPresentation(grant);
        const scope = grant.status === 'once' ? 'Once' : grant.status === 'approved' ? 'Always' : undefined;
        const busy = actionId === grant.grantId;
        const pendingGrant = grant.status === 'pending';
        const actions: TranscriptCardAction[] =
          pendingGrant && canDecide
            ? [
                {
                  label: 'No',
                  secondary: true,
                  disabled: actionId !== null,
                  onPress: () => onDecision(grant.grantId, 'deny'),
                  testID: `grant-${grant.grantId}-deny`,
                },
                ...(!sharedAssetRequest ? [{
                  label: 'Once',
                  disabled: actionId !== null,
                  onPress: () => onDecision(grant.grantId, 'once'),
                  testID: `grant-${grant.grantId}-once`,
                }] : []),
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
        if (request.sourceRoomId && request.sourceMessageId && onOpenSource) {
          actions.push({
            label: 'View request',
            accessibilityRole: 'link',
            onPress: () => onOpenSource(request.sourceRoomId!, request.sourceMessageId!),
            testID: `grant-${grant.grantId}-source`,
          });
        }
        return (
          <AgentApprovalCard
            key={grant.grantId}
            tier={pendingGrant ? 'ask' : 'record'}
            testID={`grant-${grant.grantId}`}
            askingAgent={request.agent}
            agent={agent}
            wrapTitle
            title={
              <Text testID={`grant-${grant.grantId}-ask`}>
                {`@${agentName.replace(/^@/, '')} wants to ${grant.kind === 'command' ? grant.purpose || grant.script ? 'run a script' : 'run a command' : `${grant.kind === 'mcp' && grant.target.startsWith('connection-install:') ? 'connect' : AGENT_GRANT_VERBS[grant.kind]} ${grant.appName ?? grant.target}`}`}
              </Text>
            }
            stamp={ledgerStamp(message.timestamp)}
            subline={`${grant.machine ? `${grant.machine} · ` : ''}${approvalAudience(request.owner, viewerPubkey)}`}
            body={purpose}
            facts={facts}
            foldCode
            code={script}
            codeLabel={!grant.purpose && !grant.script && grant.kind === 'command' ? 'command' : undefined}
            codeTestID={script !== undefined ? `grant-${grant.grantId}-script` : undefined}
            codePath={grant.script?.path}
            footerNote={
              pendingGrant
                ? busy
                  ? 'Sending decision…'
                  : canDecide
                  ? undefined
                  : repositoryRequest
                    ? 'waiting for a Workspace admin'
                    : sharedAssetRequest
                      ? 'waiting for a Workspace manager or the agent owner'
                    : `waiting for @${request.owner.name.replace(/^@/, '')}`
                : approvalDecisionNote(grant.status, grant.decidedBy, grant.decidedAt ?? message.timestamp, viewerPubkey)
            }
            decisionNote={!pendingGrant}
            decisionScope={scope}
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
