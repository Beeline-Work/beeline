import { expect, it } from 'vitest';
import { fishEmotionText, stripVoiceEmotion } from './voice-emotion.js';
it('preserves recognized inline speech cues while removing them only from visible text', () => {
  const text = '(excited) Great! [confident] We can do it (with help).';
  expect(fishEmotionText(text)).toBe('[excited] Great! [confident] We can do it (with help).');
  expect(stripVoiceEmotion(text)).toBe('Great! We can do it (with help).');
  expect(stripVoiceEmotion('Great! [exc')).toBe('Great!');
  expect(stripVoiceEmotion('Call fn(val')).toBe('Call fn(val');
  expect(stripVoiceEmotion('Call fn(')).toBe('Call fn(');
  expect(stripVoiceEmotion('Call fn(c')).toBe('Call fn(c');
  expect(stripVoiceEmotion('Use [a-z] and call fn(value).')).toBe('Use [a-z] and call fn(value).');
});
