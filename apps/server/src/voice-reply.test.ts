import { expect, it } from 'vitest';
import { cleanVoiceReply, voiceDateContext } from './voice-reply.js';

it.each(['Niglet: Hello.', 'nIgLeT: Hello.', '**Niglet:** Hello.', '**Niglet**: Hello.', '"Niglet": Hello.', '“Niglet:” Hello.'])
('Reproduction R1: removes only the opening own-name label: %s', text => {
  expect(cleanVoiceReply(text, 'Niglet')).toBe('Hello.');
});
it.each(['Hello, Niglet: good morning.', 'Ruby: Hello.', 'I said "Niglet: Hello."'])
('Reproduction R1: preserves other names and names inside an answer: %s', text => {
  expect(cleanVoiceReply(text, 'Niglet')).toBe(text);
});
it('Reproduction R2: makes today current evidence for every voice prompt', () => {
  expect(voiceDateContext(Date.UTC(2026, 9, 22, 21, 19))).toContain('22 October 2026');
  expect(voiceDateContext(Date.UTC(2026, 9, 22, 21, 19))).toContain('Results dated today are current');
});

it('preserves a quotation in the answer after an unquoted label', () => {
  expect(cleanVoiceReply('Niglet: “Hello,” I said.', 'Niglet')).toBe('“Hello,” I said.');
});
