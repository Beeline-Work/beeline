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
