import { describe, expect, it } from 'vitest';
import { BEELINE_SLASH_COMMANDS } from '@beeline/buzz-client';
import {
  availableSlashVerbs,
  availableCornerAppCommands,
  slashVerbQuery,
  agentMentionSlashQuery,
  insertAgentSlashCommand,
  availableAgentMentionCommands,
  fastModeCommandState,
  FAST_MODE_COMMAND,
  matchesAgentCommand,
  type SlashVerbAvailability,
} from './slash-verbs';

const allAvailable: SlashVerbAvailability = {
  canBuild: true,
  canCreatePoll: true,
  canCatchUp: true,
  canManageSchedules: true,
  canRunWorkflows: true,
  canOpenCorner: true,
  canRename: true,
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
      {
        ...allAvailable,
        canCreatePoll: false,
        canCatchUp: false,
        canCloseCorner: false,
        canChangeTargetBranch: false,
      },
      '',
    );
    expect(verbs.map((verb) => verb.command)).toEqual([
      'build',
      'schedule',
      'workflow',
      'open-corner',
      'rename',
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

  it.each([
    ['canBuild', 'build'],
    ['canCreatePoll', 'poll'],
    ['canCatchUp', 'catch-up'],
    ['canManageSchedules', 'schedule'],
    ['canRunWorkflows', 'workflow'],
    ['canOpenCorner', 'open-corner'],
    ['canRename', 'rename'],
  ] as const)('omits %s when its live capability is unavailable', (capability, command) => {
    const commands = availableSlashVerbs({ ...allAvailable, [capability]: false }, '').map(
      (verb) => verb.command,
    );
    expect(commands).not.toContain(command);
  });

  it('does not invent a release command without a shipped release action', () => {
    expect(availableSlashVerbs(allAvailable, '').some((verb) => verb.command === 'release')).toBe(
      false,
    );
  });
});

describe('dynamic Corner App commands', () => {
  const apps = [
    {
      version: 1 as const,
      slug: 'release-board',
      title: 'Release board',
      description: 'Current deployment facts',
      command: 'release-board',
      blocks: [],
      authorId: 'a'.repeat(64),
      authorName: 'Hoots',
      revision: 1,
      updatedAt: 1,
    },
  ];

  it('discovers server-projected commands by command, title, or description', () => {
    expect(availableCornerAppCommands(apps, 'release')).toEqual(apps);
    expect(availableCornerAppCommands(apps, 'deployment')).toEqual(apps);
    expect(availableCornerAppCommands(apps, 'missing')).toEqual([]);
  });
});

describe('the composer verb list stays in sync with the daemon vocabulary', () => {
  it('every Beeline command the daemon knows is a real composer verb', () => {
    const commands = availableSlashVerbs(allAvailable, '').map((verb) => verb.command);
    expect(commands).toEqual([...BEELINE_SLASH_COMMANDS]);
    expect(commands).toEqual([
      'build',
      'poll',
      'catch-up',
      'schedule',
      'workflow',
      'open-corner',
      'rename',
      'change-target-branch',
      'add-agent',
      'invite',
      'close-corner',
    ]);
  });
});

describe('the Fast mode palette entry', () => {
  const OWNER = 'owner-id';
  const fastAxis = {
    id: 'fast-mode',
    category: 'model_config',
    currentValue: 'off',
    options: [{ id: 'off' }, { id: 'on' }],
  };
  const codex = {
    catalog: [{ id: 'model', category: 'model', options: [{ id: 'gpt-5.6' }] }, fastAxis],
    fastMode: false,
    access: { policy: 'everyone' as const, owner: { id: OWNER, name: 'Owner' }, canChange: true },
  };

  it('is offered only to the owner of an agent whose live catalog supports it', () => {
    expect(fastModeCommandState(codex, OWNER)).toEqual({ enabled: false });
    expect(fastModeCommandState({ ...codex, fastMode: true }, OWNER)).toEqual({ enabled: true });
    expect(fastModeCommandState(codex, 'someone-else')).toBeNull();
    expect(fastModeCommandState(codex, undefined)).toBeNull();
    expect(fastModeCommandState({ ...codex, catalog: codex.catalog.slice(0, 1) }, OWNER)).toBeNull();
  });

  it('filters as the owner types and shows the current state', () => {
    const names = (query: string, enabled = false) =>
      availableAgentMentionCommands([], query, { enabled }).map((command) => command.name);
    expect(names('')).toEqual(['restart', FAST_MODE_COMMAND]);
    expect(names('fa')).toEqual([FAST_MODE_COMMAND]);
    expect(names('fast')).toEqual([FAST_MODE_COMMAND]);
    expect(names('res')).toEqual(['restart']);
    expect(availableAgentMentionCommands([], 'fa', { enabled: true })[0]?.toggle).toBe(true);
    expect(availableAgentMentionCommands([], 'fa', { enabled: false })[0]?.toggle).toBe(false);
  });

  it('never appears without a Fast mode state, and a harness command cannot shadow it', () => {
    expect(availableAgentMentionCommands([], 'fa', null)).toEqual([]);
    expect(availableAgentMentionCommands([], 'fa')).toEqual([]);
    const listed = availableAgentMentionCommands(
      [{ name: 'fast-mode', description: 'Harness copy' }, { name: 'fast' }],
      'fa',
      { enabled: false },
    );
    expect(listed.map((command) => [command.name, command.toggle])).toEqual([
      [FAST_MODE_COMMAND, false],
      ['fast', undefined],
    ]);
  });
});

describe('agent-mention slash palette query', () => {
  it('offers Beeline restart without a harness catalog and preserves the mention on selection', () => {
    expect(availableAgentMentionCommands([], '')).toEqual([
      { name: 'restart', description: 'Restart this agent' },
    ]);
    expect(availableAgentMentionCommands([], 'res')).toHaveLength(1);
    expect(availableAgentMentionCommands([], 'loop')).toEqual([]);
    expect(insertAgentSlashCommand('@bee /res', 'restart')).toBe('@bee /restart ');
  });

  it('does not duplicate restart if a harness advertises one', () => {
    expect(availableAgentMentionCommands([
      { name: 'restart', description: 'Harness restart' },
      { name: 'loop', description: 'Run repeatedly' },
    ], '').map((command) => command.name)).toEqual(['restart', 'loop']);
  });

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

  it('matches model and usage status metadata', () => {
    const commands = [
      { name: 'model', description: 'Show or change the agent model' },
      { name: 'usage', description: 'Show usage status' },
      { name: 'status', inputHint: 'model and account details' },
    ];
    expect(
      commands.filter((command) => matchesAgentCommand(command, 'mod')).map((c) => c.name),
    ).toEqual(['model', 'status']);
    expect(
      commands.filter((command) => matchesAgentCommand(command, 'usage')).map((c) => c.name),
    ).toEqual(['usage']);
  });

  it('preserves the exact authorizing mention when inserting a command', () => {
    expect(insertAgentSlashCommand('@agent-name /us', 'usage')).toBe('@agent-name /usage ');
  });
});
