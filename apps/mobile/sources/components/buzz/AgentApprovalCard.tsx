import React from 'react';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import type { AgentPresentation } from '@/buzz/room-view-presentation';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { ledgerStamp } from '@/buzz/relative-time';
import { IdentityMark } from './IdentityMark';
import { TranscriptCard, type TranscriptCardProps } from './TranscriptCard';

export function approvalAudience(owner: RoomViewIdentity | undefined, viewerPubkey?: string): string {
  return !owner || owner.pubkey === viewerPubkey ? 'for you' : `for @${(owner.handle ?? owner.name).replace(/^@/, '')}`;
}

export function approvalDecisionNote(status: string, by: RoomViewIdentity | undefined, at: number, viewerPubkey?: string): string {
  const verb = ['denied', 'deny'].includes(status) ? 'Denied' : status === 'expired' ? 'Expired' : status === 'failed' ? 'Failed' : status === 'revoked' ? 'Revoked' : 'Allowed';
  const who = by ? ` by ${by.pubkey === viewerPubkey ? 'you' : `@${(by.handle ?? by.name).replace(/^@/, '')}`}` : '';
  return `${verb}${who} · ${ledgerStamp(at)}`;
}

/** The host-permission anatomy shared by every agent approval. */
export function AgentApprovalCard({ askingAgent, agent, ...card }: Omit<TranscriptCardProps, 'identity'> & {
  askingAgent: RoomViewIdentity;
  agent?: AgentPresentation;
}) {
  const display = resolveAgentDisplayIdentity(askingAgent.pubkey, agent);
  return <TranscriptCard {...card} identity={<IdentityMark kind="agent"
    seed={display.avatarSeed ?? askingAgent.pubkey} avatarUrl={display.avatarUrl ?? askingAgent.avatar}
    face={display.face ?? askingAgent.face} name={agent ? display.name : askingAgent.name} size={26} />} />;
}
