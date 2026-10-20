import { assembleSessionPrompt } from '../../../../apps/body/src/prompt-assembly.js';

for (const surface of ['room', 'dm', 'code-corner', 'repo-less-corner'] as const) {
  const prompt = assembleSessionPrompt({
    surface,
    agentName: 'Bee',
    agentCommand: 'claude-agent-acp',
    soul: { name: 'Bee', instructions: 'Be concise.' },
    machineHost: { hostname: 'squire' },
    worktree: { featureBranch: 'feature/test', targetBranch: 'main' },
    cornerPrepareScript: true,
    squireAvailable: true,
    ...(surface === 'code-corner' ? {
      reviewerHandle: 'reviewer',
      brief: {
        id: 'measurement', revision: 1, authorId: 'author', sourceRoomId: 'room',
        repositoryWork: true, spec: 'Measure assigned repository work.', attachments: [],
      },
    } : {}),
  });
  console.log(surface, (prompt.systemPrompt || prompt.turnPrefix).trim().split(/\s+/).length);
}
