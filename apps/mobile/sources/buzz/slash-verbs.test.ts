import { describe, expect, it } from 'vitest';
import { availableSlashVerbs, slashVerbQuery, type SlashVerbAvailability } from './slash-verbs';

const allAvailable: SlashVerbAvailability = {
  canOpenCorner: true,
  canCloseCorner: true,
  canApprove: true,
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
      'approve',
      'add-agent',
      'invite',
    ]);
  });

  it('filters by command or visible control label as the person types', () => {
    expect(availableSlashVerbs(allAvailable, 'app').map((verb) => verb.id)).toEqual(['approve']);
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
  it('every Beeline command the daemon knows is a real composer verb', async () => {
    const { BEELINE_SLASH_COMMANDS } = await import('@beeline/buzz-client');
    const { availableSlashVerbs } = await import('./slash-verbs');
    const commands = availableSlashVerbs(allAvailable, '').map((verb) => verb.command);
    expect(commands).toEqual([...BEELINE_SLASH_COMMANDS]);
    expect(commands).toEqual([
      'open-corner',
      'approve',
      'change-target-branch',
      'add-agent',
      'invite',
      'close-corner',
    ]);
  });
});
