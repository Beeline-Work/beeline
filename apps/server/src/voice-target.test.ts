import { expect, it } from 'vitest';
import { namedVoiceTarget } from './voice-target.js';
import type { VoiceAgent } from './voice-providers.js';
const agents: VoiceAgent[] = [
  { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'ruby-voice' },
  { id: 'candy', name: 'Candy', handle: 'candy', soul: '', voice: 'candy-voice' },
];
it.each(['Candy, what do you think?', 'hey Candy help', 'Hello, @CANDY!', 'hey Candie help', 'Candi help'])('routes opening address %s', text => {
  expect(namedVoiceTarget(text, agents, 'ruby')?.id).toBe('candy');
});
it.each(['What does Candy think?', 'Tell Ruby about Candy', 'Unknown, help', 'Can you help?', ''])('keeps the selected target for %s', text => {
  expect(namedVoiceTarget(text, agents, 'ruby')?.id).toBe('ruby');
});
it('does not guess ambiguous spelling or short names', () => {
  expect(namedVoiceTarget('Candi help', [...agents, { ...agents[0]!, id: 'candie', name: 'Candie', handle: 'candie' }], 'ruby')?.id).toBe('ruby');
  expect(namedVoiceTarget('So help', [{ ...agents[0]!, name: 'Sol', handle: 'sol' }, agents[1]!], 'candy')?.id).toBe('candy');
});
it('prefers the complete display name and supports handles', () => {
  const roster = [...agents, { ...agents[0]!, id: 'rose', name: 'Ruby Rose', handle: 'rubyrose' }];
  expect(namedVoiceTarget('Hi Ruby Rose help', roster)?.id).toBe('rose');
  expect(namedVoiceTarget('@rubyrose help', roster)?.id).toBe('rose');
});
