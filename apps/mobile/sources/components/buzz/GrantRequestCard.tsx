import React from 'react';
import { Text, View } from 'react-native';
import { AGENT_GRANT_VERBS, parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { grantRequestLine } from '@/buzz/agent-grant-copy';
import { ledgerStamp } from '@/buzz/relative-time';
import { IdentityMark } from './IdentityMark';
import { TranscriptCard, type TranscriptCardAction } from './TranscriptCard';

export type GrantDecision = 'always' | 'once' | 'deny';

export interface GrantRequestCardProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  viewerIsAgent: boolean;
  viewerPubkey: string;
  viewerRole: 'owner' | 'admin' | 'member' | 'spectator' | null;
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
  viewerRole,
  viewerCanManageWorkspace,
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
      ? (viewerCanManageWorkspace ?? (viewerRole === 'admin' || viewerRole === 'owner'))
      : sharedAssetRequest
        ? Boolean(viewerCanManageWorkspace ?? (viewerRole === 'admin' || viewerRole === 'owner')) ||
          viewerPubkey === request.owner.pubkey
      : viewerPubkey === request.owner.pubkey);
  const anyPending = request.grants.some((grant) => grant.status === 'pending');
  return (
    <View testID={`grant-request-${anyPending ? 'pending' : 'settled'}`}>
      {request.grants.map((grant) => {
        const script = grant.script?.contents ?? (grant.kind === 'command' ? grant.target : undefined);
        const purpose = grant.purpose;
        const basename = (value: string) => value.split(/[\\/]/).pop() || value;
        let runs: string | undefined;
        if (grant.kind === 'command') {
          try { runs = parseCommandGrantTarget(grant.target).argv.map(basename).join(' '); }
          catch { /* Legacy targets may predate the command grammar. */ }
        }
        const facts = purpose ? [
          ...(runs ? [{ label: 'Runs', value: runs }] : []),
          ...(grant.touches ? [{ label: 'Touches', value: grant.touches }] : grant.kind !== 'command' ? [{ label: 'Touches', value: grant.appName ?? grant.target }] : []),
          ...(grant.capabilities ? [{ label: 'Can', value: grant.capabilities }] : []),
        ] : [];
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
            wrapTitle
            title={
              <Text testID={`grant-${grant.grantId}-ask`}>
                {purpose ? `@${agentName.replace(/^@/, '')} wants to ${grant.kind === 'command' ? 'run a script' : `${grant.kind === 'mcp' && grant.target.startsWith('connection-install:') ? 'connect' : AGENT_GRANT_VERBS[grant.kind]} ${grant.appName ?? grant.target}`}` : grantRequestLine(request.requester.name, `@${agentName.replace(/^@/, '')}`, grant)}
              </Text>
            }
            stamp={ledgerStamp(message.timestamp)}
            subline={purpose ? `${grant.machine ? `${grant.machine} · ` : ''}${request.owner.pubkey === viewerPubkey ? 'for you' : `for @${request.owner.name.replace(/^@/, '')}`}` : undefined}
            body={purpose}
            facts={facts}
            foldCode
            code={script}
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
                : purpose && grant.decidedBy && grant.decidedAt && ['once', 'approved', 'denied'].includes(grant.status)
                  ? `${grant.status === 'denied' ? 'Denied' : 'Allowed'} by ${grant.decidedBy.pubkey === viewerPubkey ? 'you' : `@${grant.decidedBy.name.replace(/^@/, '')}`} · ${ledgerStamp(grant.decidedAt)}`
                : grant.status === 'once'
                  ? 'allowed once'
                  : grant.status === 'approved'
                    ? 'always allowed'
                    : grant.status === 'denied'
                      ? 'denied'
                      : 'revoked'
            }
            decisionNote={Boolean(purpose) && !pendingGrant}
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
