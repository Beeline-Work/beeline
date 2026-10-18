import type { VoiceCall } from '@beeline/api-contract/phone';

/** Both call surfaces show the humans in the committed call roster. */
export function voiceCallHumanNames(call: VoiceCall, viewer?: string): string {
  return call.participants.filter(person => person.kind === 'human')
    .sort((a, b) => Number(b.pubkey === viewer) - Number(a.pubkey === viewer))
    .map(person => person.pubkey === viewer ? 'You' : person.name).join(', ');
}
