
import { expect as move10_expect, it as move10_it } from 'vitest';

import { readAgentVoiceCatalog as move10_readAgentVoiceCatalog, readAgentVoicePreview as move10_readAgentVoicePreview } from "./voice.js";
import { describe as movedDescribe10 } from 'vitest';
movedDescribe10("voice-profile.test.ts", () => {

const catalog = {
  currentVoiceId: 'one',
  canChange: true,
  choices: [{ id: 'one', name: 'One' }],
};

move10_it('validates current library selection and rejects duplicate voices and missing current ids', () => {
  move10_expect(move10_readAgentVoiceCatalog(catalog)).toEqual(catalog);
  move10_expect(move10_readAgentVoiceCatalog({ ...catalog, currentVoiceId: 'missing' })).toBeNull();
  move10_expect(move10_readAgentVoiceCatalog({ ...catalog, choices: [...catalog.choices, ...catalog.choices] })).toBeNull();
  move10_expect(move10_readAgentVoicePreview({ url: 'https://evil.test/audio.mp3' })).toBeNull();
  move10_expect(move10_readAgentVoicePreview({ wavBase64: 'YWJj' })).toEqual({ wavBase64: 'YWJj' });
  move10_expect(move10_readAgentVoicePreview({ wavBase64: '<script>' })).toBeNull();
});
});
