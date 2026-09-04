import { describe, expect, it } from 'vitest';
import {
  isCornerStatusRestatement,
  sanitizeAgentReply,
  stripCornerOpenEcho,
} from './reply-sanitizer.js';

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

describe('stripCornerOpenEcho', () => {
  it.each([
    'Opened corner 3f2a9c1e-77d2-4b0e-9d1a-0c5b2e8f4a11 with the objective "Fix the widget".',
    "I've opened a corner for this: Fix the widget. I'll report back when the PR is up.",
    'Okay, opening a new write-enabled corner now.',
    'Done. Opened the repository corner (id 3f2a9c1e).',
  ])("drops the model's own announcement after the server posted the corner card: %j", (echo) => {
    expect(stripCornerOpenEcho(echo)).toBe('');
  });

  it('keeps anything the model says after the announcement paragraph', () => {
    expect(
      stripCornerOpenEcho(
        'Opened corner 3f2a9c1e for the widget fix.\n\nNote: the repo has no test runner, so I will add vitest first.',
      ),
    ).toBe('Note: the repo has no test runner, so I will add vitest first.');
  });

  it('keeps a reply that only mentions a corner without announcing one', () => {
    const reply = 'The corner from yesterday merged already; nothing to open here.';
    expect(stripCornerOpenEcho(reply)).toBe(reply);
    expect(stripCornerOpenEcho('I could not open a corner: this Room has no repository.')).toBe(
      'I could not open a corner: this Room has no repository.',
    );
  });

  it('keeps a long first paragraph even when it starts as the announcement', () => {
    const long = `Opened corner 3f2a9c1e. ${'The plan has several parts. '.repeat(16)}`.trim();
    expect(stripCornerOpenEcho(long)).toBe(long);
  });
});

describe('isCornerStatusRestatement', () => {
  const passed = ['GitHub passed a check Beeline CI'];

  it.each([
    'PR checks have passed.',
    'CI has passed',
    'PR remains ready for review.',
    'Beeline CI is green now; nothing further needed.',
    'All checks passed. The PR is still ready for review.',
    'Checks passed, no action required.',
    '',
  ])('drops a reply that only restates the server line: %j', (reply) => {
    expect(isCornerStatusRestatement(reply, passed)).toBe(true);
  });

  it.each([
    'Merged https://github.com/acme/widgets/pull/7',
    'Checks passed. Merging the PR now.',
    'Fixed the lint error and pushed a new commit.',
    'Beeline CI failed on the typecheck step; looking into it.',
    'Checks passed but the branch is held: waiting for @captain to resume.',
    'Checks passed. The PR is ready. I also updated the changelog. Let me know.',
  ])('keeps a reply that carries anything beyond the line: %j', (reply) => {
    expect(isCornerStatusRestatement(reply, passed)).toBe(false);
  });

  it('admits only the words of the lines it was given', () => {
    const failed = ['GitHub failed a check Beeline CI · lint'];
    expect(isCornerStatusRestatement('CI failed on lint.', failed)).toBe(true);
    expect(isCornerStatusRestatement('CI failed on lint.', passed)).toBe(false);
    expect(isCornerStatusRestatement('The PR merged.', ['GitHub merged Ship the widget'])).toBe(
      true,
    );
    expect(isCornerStatusRestatement('The PR merged.', passed)).toBe(false);
  });
});
