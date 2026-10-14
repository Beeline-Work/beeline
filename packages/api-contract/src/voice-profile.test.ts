import { expect, it } from 'vitest';
import { readAgentVoiceCatalog, readAgentVoicePreview } from './voice.js';
const catalog = {
  currentVoiceId: 'one',
  canChange: true,
  choices: [{ id: 'one', name: 'One' }],
};
it('validates current library selection and rejects duplicate voices and missing current ids', () => {
  expect(readAgentVoiceCatalog(catalog)).toEqual(catalog);
  expect(readAgentVoiceCatalog({ ...catalog, currentVoiceId: 'missing' })).toBeNull();
  expect(readAgentVoiceCatalog({ ...catalog, choices: [...catalog.choices, ...catalog.choices] })).toBeNull();
  expect(readAgentVoicePreview({ url: 'https://evil.test/audio.mp3' })).toBeNull();
  expect(readAgentVoicePreview({ wavBase64: 'YWJj' })).toEqual({ wavBase64: 'YWJj' });
  expect(readAgentVoicePreview({ wavBase64: '<script>' })).toBeNull();
});
