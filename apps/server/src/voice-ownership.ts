/** All LiveKit room names, including legacy cleanup, go through this function. */
export function voiceRoomName(callId: string, epoch: number): string {
  return epoch === 0 ? `beeline-voice-${callId}` : `beeline-voice-${callId}-e${epoch}`;
}

import type { VoiceOwner } from '@beeline/api-contract/phone';
export type { VoiceOwner } from '@beeline/api-contract/phone';
export class VoiceOwnershipError extends Error {
  constructor(readonly state: 'elsewhere' | 'replaced', readonly owner?: VoiceOwner) {
    super(state === 'elsewhere' ? 'Call active on another device' : 'Call replaced on another device');
  }
}

export function voiceRtcIdentity(account: string, device: string, epoch: number): string {
  return `${account}:${device}:${epoch}`;
}

export function voiceRtcAccount(identity: string): string {
  return identity.split(':')[0]!;
}
