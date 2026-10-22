import { expect, it } from 'vitest';
import { nameSound, namedVoiceTarget, openingVoiceName } from './voice-target.js';
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

it.each(['Gussie, are you there?', 'hey Goosey help', 'Goosy what do you think', 'ok Gussy listen'])('routes the sound of Goosy in %s', text => {
  const roster = [...agents, { id: 'goosy', name: 'Goosy', handle: 'goosy', soul: '', voice: 'goosy-voice' }];
  expect(nameSound('Gussie')).toBe(nameSound('Goosy'));
  expect(nameSound('Goosey')).toBe(nameSound('Goosy'));
  expect(namedVoiceTarget(text, roster, 'ruby', 2)?.id).toBe('goosy');
  expect(namedVoiceTarget(text, roster, 'ruby', 1)?.id).toBe('goosy');
});
it('resolves an ambiguous sound to no target with several humans and keeps the lock for one human', () => {
  const roster = [...agents, { id: 'goosy', name: 'Goosy', handle: 'goosy', soul: '', voice: '' },
    { id: 'gussie', name: 'Gussie', handle: 'gussie', soul: '', voice: '' }];
  expect(namedVoiceTarget('Goosey help', roster, 'ruby', 2)).toBeUndefined();
  expect(namedVoiceTarget('Goosey help', roster, 'ruby', 1)?.id).toBe('ruby');
  expect(namedVoiceTarget('Hoots, hats or hits', [{ id: 'hoots', name: 'Hoots', handle: 'hoots', soul: '', voice: '' }], undefined, 2)?.id).toBe('hoots');
  expect(namedVoiceTarget('Hats off', [{ id: 'hoots', name: 'Hoots', handle: 'hoots', soul: '', voice: '' }], undefined, 2)).toBeUndefined();
});

it.each(['um hey Candy help', 'uh, Candie', 'so Candy help', 'alright Candy help',
  'okay so Candy help', 'oh hey Candy help', 'um uh er ah Candy help', 'erm well right Candy help',
  'ah hello Candy help', 'yo ok Candy help'])('VOICE-FILLER-1: skips stacked opening fillers in %s', text => {
  expect(openingVoiceName(text, agents)?.id).toBe('candy');
});
it('VOICE-FILLER-1: stacked fillers preserve sound matching and reject speech without an opening name', () => {
  const roster = [...agents, { ...agents[0]!, id: 'goosy', name: 'Goosy', handle: 'goosy' }];
  expect(openingVoiceName('okay so Goosy help', roster)?.id).toBe('goosy');
  expect(openingVoiceName('um hey Goosey help', roster)?.id).toBe('goosy');
  expect(openingVoiceName('so what do you think', roster)).toBeUndefined();
  expect(openingVoiceName('um uh er ah hey Candy help', roster)).toBeUndefined();
  expect(openingVoiceName('uh So help', [{ ...agents[0]!, name: 'Sol', handle: 'sol' }])).toBeUndefined();
  expect(openingVoiceName('um hey Candi help', [...agents,
    { ...agents[0]!, id:'candie', name:'Candie', handle:'candie' }])).toBeUndefined();
});
it.each(['Ok', 'Hey', 'Right', 'So'])('VOICE-FILLER-1: protects an agent named %s before dropping filler', name => {
  const roster = [...agents, { ...agents[0]!, id: 'filler', name, handle: name.toLowerCase() }];
  expect(openingVoiceName(`${name} Candy help`, roster)?.id).toBe('filler');
  expect(openingVoiceName(`um ${name} Candy help`, roster)?.id).toBe('filler');
});
it('VOICE-FILLER-1: protects a filler handle, full display name and ambiguity', () => {
  const roster = [...agents, { ...agents[0]!, id: 'filler', name:'Charles', handle:'ok' },
    { ...agents[0]!, id:'greeting', name:'Hey Charles', handle:'heycharles' }];
  expect(openingVoiceName('um ok Candy help', roster)?.id).toBe('filler');
  expect(openingVoiceName('uh hey Charles help', roster)?.id).toBe('greeting');
  expect(openingVoiceName('um ok Candy help', [...roster,
    { ...agents[0]!, id:'duplicate', name:'Ok', handle:'duplicate' }])).toBeUndefined();
});
