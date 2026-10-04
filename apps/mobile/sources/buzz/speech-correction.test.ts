import { describe, expect, it } from 'vitest';
import { createSpeechCorrector } from './speech-correction';

const LEXICON = [
  'Groq',
  'OpenRouter',
  'ElevenLabs',
  'Beeline',
  'Hoots',
  'Ruby',
  'Candy',
  'Trusty Squire',
  'brief',
  'useSpeechInput',
];

const correct = (...alternatives: string[]) => createSpeechCorrector(LEXICON).correct(alternatives);

describe('createSpeechCorrector', () => {
  it('snaps a sound-alike word to a Room proper noun', () => {
    expect(correct('Compare Croc and the others')).toBe('Compare Groq and the others');
  });

  it('joins a run of spoken words into one term', () => {
    expect(correct('send it through open rotor.')).toBe('send it through OpenRouter.');
    expect(correct('the eleven labs pricing')).toBe('the ElevenLabs pricing');
    expect(correct('open the bee line app')).toBe('open the Beeline app');
  });

  it('keeps the punctuation around a snapped term', () => {
    expect(correct('Is it (croc)? Yes, croc!')).toBe('Is it (Groq)? Yes, Groq!');
  });

  it('does not join words across punctuation', () => {
    expect(correct('open, rotor')).toBe('open, rotor');
  });

  it('leaves ordinary words alone', () => {
    expect(correct('the hats were on the crack')).toBe('the hats were on the crack');
    expect(correct('a rabbi with candy')).toBe('a rabbi with candy');
    expect(correct('use speech input here')).toBe('use speech input here');
    expect(correct('a brief breve')).toBe('a brief breve');
  });

  it('prefers the alternative naming the most Room terms', () => {
    expect(correct('ask crack about open router', 'ask croc about open router')).toBe(
      'ask Groq about OpenRouter',
    );
  });

  it("keeps the recognizer's order on a tie and skips empty alternatives", () => {
    expect(correct('', 'first guess', 'second guess')).toBe('first guess');
  });

  it('returns text unchanged with an empty lexicon', () => {
    expect(createSpeechCorrector([]).correct(['Croc open rotor'])).toBe('Croc open rotor');
  });
});
