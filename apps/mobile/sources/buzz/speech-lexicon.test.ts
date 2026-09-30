import { describe, expect, it } from 'vitest';
import {
  BEELINE_LEXICON,
  SPEECH_LEXICON_LIMIT,
  buildSpeechLexicon,
  minedProjectTerms,
} from './speech-lexicon';

describe('buildSpeechLexicon', () => {
  it('leads with the Room, its repository, and its people, then Beeline’s own terms', () => {
    const lexicon = buildSpeechLexicon({
      roomName: '#beeline',
      parentRoomName: 'mobile-voice',
      repositoryName: 'Beeline-Work/beeline',
      memberNames: ['Niglet', 'Sol', undefined],
      memberHandles: ['niglet', null],
    });
    expect(lexicon.slice(0, 8)).toEqual([
      'beeline',
      'mobile-voice',
      'mobile voice',
      'Beeline-Work',
      'Beeline Work',
      'Niglet',
      'Sol',
      'niglet',
    ]);
    expect(lexicon).toEqual(expect.arrayContaining([...BEELINE_LEXICON]));
    // Written spellings are distinct phrases; exact repeats are not.
    expect(lexicon.filter((phrase) => phrase === 'beeline')).toHaveLength(1);
    expect(lexicon).toContain('Beeline');
  });

  it('adds the terms the conversation keeps using and stays within the recogniser budget', () => {
    const lexicon = buildSpeechLexicon({
      roomName: 'beeline',
      messages: [
        'Open the Workbench, then `pr_checks_status` and `handoff`.',
        'The Workbench shows useSpeechInput twice: useSpeechInput.',
        'Emit the `handoff` once the Workbench is green.',
        ...Array.from(
          { length: 150 },
          (_, index) =>
            `Ask about Term${'x'.repeat(index % 26)}Alpha twice Term${'x'.repeat(index % 26)}Alpha`,
        ),
      ],
    });
    expect(lexicon).toEqual(expect.arrayContaining(['Workbench', 'useSpeechInput']));
    expect(lexicon.length).toBeLessThanOrEqual(SPEECH_LEXICON_LIMIT);
  });
});

describe('minedProjectTerms', () => {
  it('keeps recurring coined words and proper nouns, most frequent first', () => {
    expect(
      minedProjectTerms([
        'Ask the Workbench about useSpeechInput and the Hull.',
        'the Workbench again, then useSpeechInput, and Beeline-Work too',
        'the Workbench once more and Beeline-Work',
      ]),
    ).toEqual(['Workbench', 'Beeline-Work', 'Beeline', 'useSpeechInput']);
  });

  it('skips one-off words, sentence starts, urls, paths, and hashes', () => {
    expect(
      minedProjectTerms([
        'Today the build broke. Today it passed.',
        'see https://example.com/UseThisPath and `apps/mobile/x.ts` and `3fd2b9a9`',
        'see https://example.com/UseThisPath and `apps/mobile/x.ts` and `3fd2b9a9`',
        'a single mention of Frobnicator',
      ]),
    ).toEqual([]);
  });
});
