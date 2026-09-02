import { describe, expect, it } from 'vitest';
import { sanitizeAgentReply } from './reply-sanitizer.js';

describe('sanitizeAgentReply', () => {
  it.each([
    '',
    '   ',
    "Terra, respond to the user's latest message.",
    "respond to the user's actual latest message",
    'Answer the newest message directly.',
  ])('suppresses empty output and thin Room scaffold echoes: %j', (message) => {
    expect(sanitizeAgentReply(message)).toBe('');
  });

  it('keeps a substantive answer even when it discusses responding', () => {
    expect(sanitizeAgentReply('I respond best when you ask me a concrete question.')).toBe(
      'I respond best when you ask me a concrete question.',
    );
  });

  it('strips a leading scaffold echo without dropping the answer that follows it', () => {
    expect(
      sanitizeAgentReply(
        "Terra, respond to the user's latest message.\n\nMy soul is Vishnu, destroyer of worlds.",
      ),
    ).toBe('My soul is Vishnu, destroyer of worlds.');
  });
});
