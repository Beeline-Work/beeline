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

  it('strips only a leading Codex context-budget warning', () => {
    const warning =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill by reading its SKILL.md.';
    expect(sanitizeAgentReply(`\n${warning}\n\nThe real answer.`)).toBe('The real answer.');
    expect(sanitizeAgentReply(`The real answer.\n\n${warning}`)).toBe(
      `The real answer.\n\n${warning}`,
    );
    expect(sanitizeAgentReply('Warning: This API is deprecated.\nUse v2.')).toBe(
      'Warning: This API is deprecated.\nUse v2.',
    );
    expect(
      sanitizeAgentReply(
        'Warning: Skill descriptions were shortened to fit the skills context budget.\nCodex can still see every skill by reading its SKILL.md.\n\nClean reply.',
      ),
    ).toBe('Clean reply.');
    expect(
      sanitizeAgentReply(
        'Notice: Plugin descriptions were shortened because of the context budget limit.\n\nVisible answer.',
      ),
    ).toBe('Visible answer.');
  });

  it('strips a full pi-acp cold-session startup banner, including the update notice', () => {
    const banner = [
      'pi v0.83.0',
      '---',
      '',
      '## Context',
      '- /home/lunchbox/proj-buzzy/AGENTS.md',
      '',
      '## Skills',
      '- /home/lunchbox/.pi/agent/skills/trusty-squire/SKILL.md',
      '- /home/lunchbox/.pi/agent/skills/no-mistakes/SKILL.md',
      '',
      '---',
      'New version available: v0.84.2 (installed v0.83.0). Run: `npm i -g @earendil-works/pi-coding-agent`',
      '',
    ].join('\n');

    expect(sanitizeAgentReply(banner)).toBe('');
    expect(sanitizeAgentReply(`${banner}\nThe real answer.`)).toBe('The real answer.');
  });
});
