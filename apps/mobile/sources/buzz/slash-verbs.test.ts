import { describe, expect, it } from 'vitest';
import { BEELINE_SLASH_COMMANDS } from '@beeline/buzz-client';
import {
  availableSlashVerbs,
  slashVerbQuery,
  agentMentionSlashQuery,
  matchesAgentCommand,
  type SlashVerbAvailability,
} from './slash-verbs';

const allAvailable: SlashVerbAvailability = {
  canOpenCorner: true,
  canCloseCorner: true,
  canChangeTargetBranch: true,
  canAddAgent: true,
  canInvitePerson: true,
};

describe('Buzz composer built-in slash verbs', () => {
  it('opens only for a slash token occupying the composer', () => {
    expect(slashVerbQuery('/')).toBe('');
    expect(slashVerbQuery('/APP')).toBe('app');
    expect(slashVerbQuery('please /approve')).toBeNull();
    expect(slashVerbQuery('/approve now')).toBeNull();
    expect(slashVerbQuery('')).toBeNull();
  });

  it('lists only real controls currently available in this Room or corner', () => {
    const verbs = availableSlashVerbs(
      { ...allAvailable, canCloseCorner: false, canChangeTargetBranch: false },
      '',
    );
    expect(verbs.map((verb) => verb.command)).toEqual([
      'open-corner',
      'add-agent',
      'invite',
    ]);
  });

  it('filters by command or visible control label as the person types', () => {
    expect(availableSlashVerbs(allAvailable, 'app')).toEqual([]);
    expect(availableSlashVerbs(allAvailable, 'target').map((verb) => verb.id)).toEqual([
      'change-target-branch',
    ]);
    expect(availableSlashVerbs(allAvailable, 'zzz')).toEqual([]);
  });

  it('does not invent a release command without a shipped release action', () => {
    expect(availableSlashVerbs(allAvailable, '').some((verb) => verb.command === 'release')).toBe(
      false,
    );
  });
});

describe('the composer verb list stays in sync with the daemon vocabulary', () => {
  it('every Beeline command the daemon knows is a real composer verb', () => {
    const commands = availableSlashVerbs(allAvailable, '').map((verb) => verb.command);
    expect(commands).toEqual([...BEELINE_SLASH_COMMANDS]);
    expect(commands).toEqual([
      'open-corner',
      'change-target-branch',
      'add-agent',
      'invite',
      'close-corner',
    ]);
  });
});

describe('agent-mention slash palette query', () => {
  it('detects a slash token typed right after a completed @mention', () => {
    expect(agentMentionSlashQuery('@lena /lo')).toEqual({ mention: 'lena', query: 'lo' });
    expect(agentMentionSlashQuery('@lena /')).toEqual({ mention: 'lena', query: '' });
    expect(agentMentionSlashQuery('hey @beebee_2 /rev')).toEqual({
      mention: 'beebee_2',
      query: 'rev',
    });
    // Trailing whitespace after the token closes the palette.
    expect(agentMentionSlashQuery('@lena /lo ')).toBeNull();
  });

  it('stays closed for ordinary prose and non-mention shapes', () => {
    expect(agentMentionSlashQuery('/loop')).toBeNull();
    expect(agentMentionSlashQuery('@lena hello /loop')).toBeNull();
    expect(agentMentionSlashQuery('@lena/loop')).toBeNull();
    expect(agentMentionSlashQuery('@lena /etc/hosts')).toBeNull();
    expect(agentMentionSlashQuery('@lena /loop extra')).toBeNull();
    expect(agentMentionSlashQuery('email me at bob@example.com')).toBeNull();
  });

  it('matches commands on name prefix or description substring', () => {
    const loop = { name: 'loop', description: 'Run repeatedly' };
    expect(matchesAgentCommand(loop, '')).toBe(true);
    expect(matchesAgentCommand(loop, 'lo')).toBe(true);
    expect(matchesAgentCommand(loop, 'LOOP')).toBe(true);
    expect(matchesAgentCommand(loop, 'repeat')).toBe(true);
    expect(matchesAgentCommand(loop, 'xyz')).toBe(false);
  });
});
