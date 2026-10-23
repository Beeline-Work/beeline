import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import { ledgerStamp } from '@/buzz/relative-time';

export function approvalDecisionNote(status: string, by: RoomViewIdentity | undefined, at: number, viewerPubkey?: string, action?: string): string {
  if (status === 'expired' && action) return `The request to ${action} expired · ${ledgerStamp(at)}`;
  const verb = ['denied', 'deny'].includes(status) ? 'Denied' : status === 'expired' ? 'Expired' : status === 'failed' ? 'Failed' : status === 'revoked' ? 'Revoked' : 'Allowed';
  const who = by ? ` by ${by.pubkey === viewerPubkey ? 'you' : `@${(by.handle ?? by.name).replace(/^@/, '')}`}` : '';
  return `${verb}${who} · ${ledgerStamp(at)}`;
}

