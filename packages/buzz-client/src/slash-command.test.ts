import { describe, expect, it } from 'vitest';
import {
  BEELINE_SLASH_COMMANDS,
  beelineSlashCommandList,
  isBeelineSlashCommand,
  matchSlashCommand,
} from './slash-command.js';

describe('matchSlashCommand', () => {
  it('recognizes a bare unknown verb', () => {
    expect(matchSlashCommand('/loop')).toEqual({ command: 'loop', args: '' });
  });

  it('recognizes a verb with arguments', () => {
    expect(matchSlashCommand('/loop every 5 minutes until tests pass')).toEqual({
      command: 'loop',
      args: 'every 5 minutes until tests pass',
    });
  });

  it('recognizes a command whose arguments continue on the next line', () => {
    expect(matchSlashCommand('/loop\ndo the thing')).toEqual({
      command: 'loop',
      args: 'do the thing',
    });
  });

  it('is case-insensitive on the verb and lowercases it', () => {
    expect(matchSlashCommand('/LOOP now')).toEqual({ command: 'loop', args: 'now' });
  });

  it.each([
    '/etc/hosts is readable',
    '/usr/bin/env run the tests',
    '// not a command',
    '/',
    '/1starts-with-a-digit',
    'open a corner please',
    '',
    '   ',
  ])('keeps prose and paths out of the command shape: %j', (text) => {
    expect(matchSlashCommand(text)).toBeNull();
  });

  it('keeps a multi-line message that merely opens with a path-shaped line out', () => {
    expect(matchSlashCommand('/etc/hosts\nlooks fine to me')).toBeNull();
  });
});

describe('BEELINE_SLASH_COMMANDS', () => {
  it('is exactly the five composer verbs that work today', () => {
    expect([...BEELINE_SLASH_COMMANDS]).toEqual([
      'open-corner',
      'change-target-branch',
      'add-agent',
      'invite',
      'close-corner',
    ]);
  });

  it('classifies its own verbs and foreign ones distinctly', () => {
    expect(isBeelineSlashCommand('approve')).toBe(false);
    expect(isBeelineSlashCommand('/OPEN-CORNER'.slice(1))).toBe(true);
    expect(isBeelineSlashCommand('loop')).toBe(false);
  });

  it('renders a slash-prefixed list for the daemon notice copy', () => {
    expect(beelineSlashCommandList()).toBe(
      '/open-corner, /change-target-branch, /add-agent, /invite, /close-corner',
    );
  });
});
