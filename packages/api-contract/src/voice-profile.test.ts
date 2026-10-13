import { expect, it } from 'vitest';
import { readAgentVoiceCatalog, readAgentVoicePreview } from './voice.js';
const catalog = {
  provider: 'fish-s2.1-pro',
  currentVoiceId: 'one',
  canChange: true,
  choices: [{ id: 'one', name: 'One', sampleUrl: 'https://platform.r2.fish.audio/sample.mp3' }],
};
it('validates current library selection and rejects unsafe sample hosts, duplicate voices, and missing current ids', () => {
  expect(readAgentVoiceCatalog(catalog)).toEqual(catalog);
  expect(readAgentVoiceCatalog({ ...catalog, currentVoiceId: 'missing' })).toBeNull();
  expect(
    readAgentVoiceCatalog({ ...catalog, choices: [...catalog.choices, ...catalog.choices] }),
  ).toBeNull();
  expect(
    readAgentVoiceCatalog({
      ...catalog,
      choices: [
        { id: 'one', name: 'One', sampleUrl: 'https://platform.r2.fish.audio.evil.test/audio.mp3' },
      ],
    }),
  ).toBeNull();
  expect(readAgentVoicePreview({ url: 'https://evil.test/audio.mp3' })).toBeNull();
  expect(readAgentVoicePreview({ wavBase64: 'YWJj' })).toEqual({ wavBase64: 'YWJj' });
  expect(readAgentVoicePreview({ wavBase64: '<script>' })).toBeNull();
});
