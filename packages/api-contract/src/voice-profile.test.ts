import { expect, it } from 'vitest';
import { readAgentVoiceCatalog, readAgentVoicePreview, VOICE_PROVIDERS, DEFAULT_VOICE_PROVIDER } from './voice.js';
const catalog = {
  provider: 'aura-2',
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

it('offers only Aura 2 and rejects dormant provider catalogs', () => {
  expect(VOICE_PROVIDERS).toEqual(['aura-2']);
  expect(DEFAULT_VOICE_PROVIDER).toBe('aura-2');
  expect(readAgentVoiceCatalog({ ...catalog, provider: 'fish-s2.1-pro' })).toBeNull();
  expect(readAgentVoiceCatalog({ ...catalog, provider: 'kokoro-deepinfra' })).toBeNull();
});
