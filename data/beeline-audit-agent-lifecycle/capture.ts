// Run from the repository root: node --import tsx data/beeline-audit-agent-lifecycle/capture.ts > capture.json
import { readFileSync, readdirSync } from 'node:fs';
import {
  assembleSessionPrompt, assembleTurnPrompt, cornerReviewerInstruction,
  CORNER_CHECKS_NUDGE, CORNER_DELIVERY_NUDGE,
} from '../../apps/body/src/prompt-assembly.js';

const prompts: Record<string, string> = {};
for (const file of readdirSync('docs/prompts').filter((file) => file.endsWith('.md'))) {
  const text = readFileSync(`docs/prompts/${file}`, 'utf8');
  const body = /```text\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (body !== undefined) prompts[file.replace(/\.md$/, '')] = body;
}
const brief = {
  id: 'corner', revision: 1, authorId: 'author', sourceRoomId: 'room',
  attachments: [], repositoryWork: true,
  spec: '## Intent\nFix the widget\n## Assigned files\napps/body/src/widget.ts',
};
const sessions = {
  room: assembleSessionPrompt({ surface: 'room', agentName: 'Bee', agentCommand: 'codex-acp', memoryMaxBytes: 8 * 1024 ** 3 }),
  corner: assembleSessionPrompt({ surface: 'code-corner', agentName: 'Bee', agentCommand: 'codex-acp', brief,
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' }, reviewerHandle: 'sol', memoryMaxBytes: 8 * 1024 ** 3 }),
};
for (const kind of ['order', 'report'] as const) {
  prompts[`room-${kind}-wake-codex`] = assembleTurnPrompt({ surface: 'room', sessionPrefix: sessions.room.turnPrefix,
    task: { fromName: kind === 'order' ? 'Sol' : 'Bee', commandReason: kind,
      body: kind === 'order' ? 'Fix the widget in a corner.' : 'done: Fixed the widget.' },
  }).text;
}
for (const commandReason of ['human_tag', 'corner_check', 'corner_land', 'order', 'report']) {
  prompts[`corner-${commandReason}-wake-codex`] = assembleTurnPrompt({ surface: 'code-corner',
    sessionPrefix: sessions.corner.turnPrefix, brief: { brief, fileLines: [], missingRequiredFile: false },
    task: { commandReason, body: commandReason === 'report' ? 'done: Fixed the widget.' : 'Fix the widget.' },
  }).text;
}
prompts['review-target'] = cornerReviewerInstruction({ isReviewer: true, pullRequestNumber: 1,
  headSha: 'a'.repeat(40), briefRevision: 1 })!;
prompts['checks-nudge'] = CORNER_CHECKS_NUDGE;
prompts['delivery-nudge'] = CORNER_DELIVERY_NUDGE;
process.stdout.write(JSON.stringify(prompts, null, 2) + '\n');
