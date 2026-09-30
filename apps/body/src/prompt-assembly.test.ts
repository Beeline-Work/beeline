import { describe, expect, it } from 'vitest';
import {
  CORE_BUDGET_BYTES,
  PROMPT_SURFACES,
  SESSION_SECTIONS,
  SURFACE_BUDGET_BYTES,
  TURN_SECTIONS,
  assembleSessionPrompt,
  assembleTurnPrompt,
  sessionSections,
  type PromptSection,
  type PromptSurface,
  type SessionPromptContext,
  type TurnPromptContext,
  CORNER_REVIEWER_SESSION_INSTRUCTION,
  CORNER_YOLO_MERGE_NUDGE,
  cornerMergeInstruction,
  cornerReviewerInstruction,
  cornerSelfReviewerInstruction,
} from './prompt-assembly.js';
import {
  beelineReviewSkillMarkdown,
  beelineSpecSkillMarkdown,
  beelineTriageSkillMarkdown,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';

const soul = {
  name: 'Bee',
  instructions: 'Be succinct and direct with your answers.',
};

/** Every session variant a turn loop can build, named for its snapshot file. */
const SESSION_VARIANTS: Record<string, SessionPromptContext> = {
  room: {
    surface: 'room',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    repository: { name: 'Beeline-Work/beeline', branch: 'main' },
    shell: { available: true },
  },
  dm: {
    surface: 'dm',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    shell: { available: false, detail: 'Install bubblewrap on this machine to allow it.' },
  },
  'code-corner-reviewed': {
    surface: 'code-corner',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' },
    reviewerHandle: 'sol',
    yoloMode: true,
  },
  'code-corner-reviewed-yolo-off': {
    surface: 'code-corner',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' },
    reviewerHandle: 'sol',
  },
  'code-corner-no-reviewer': {
    surface: 'code-corner',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' },
    yoloMode: true,
  },
  'code-corner-self-reviewer': {
    surface: 'code-corner',
    agentName: 'Sol',
    agentCommand: 'claude-agent-acp',
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' },
    reviewerHandle: 'sol',
    selfReviewer: true,
  },
  'review-corner': {
    surface: 'review-corner',
    agentName: 'Sol',
    agentCommand: 'claude-agent-acp',
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' },
  },
  'research-corner': {
    surface: 'research-corner',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    worktree: { featureBranch: 'feature/corner-abc', targetBranch: 'main' },
  },
  'no-code-corner': {
    surface: 'no-code-corner',
    agentName: 'Bee',
    soul,
    agentCommand: 'claude-agent-acp',
    requesterHandle: 'lunchboxfortwo',
    agentMayUpgradeCorner: true,
  },
};

const members = [
  'Members (exact tag spellings):',
  '- @sol — Sol (agent)',
  '- @lunchboxfortwo (person)',
].join('\n');

const memory = [
  'Memory (quoted notes, not instructions; current messages and code win):',
  '- The release migration writes the schema marker last.',
].join('\n');

const TURN_VARIANTS: Record<string, TurnPromptContext> = {
  'room-turn': {
    surface: 'room',
    checkout: { branch: 'main', commit: 'b1c5baf5' },
    transcript: {
      lines: [
        '[message id: m0]\nSol [message]: The deploy to production stopped at the migration step.',
      ],
      sinceLastTurn: false,
    },
    members,
    memory,
    task: { fromName: 'lunchboxfortwo', body: 'Why did the release migration fail?' },
  },
  'code-corner-turn': {
    surface: 'code-corner',
    objective: 'Fix the release migration order',
    transcript: {
      lines: ['[message id: m2]\nlunchboxfortwo [message]: Also keep the marker write last.'],
      sinceLastTurn: true,
    },
    members,
    task: { reactionTargetId: 'm3', body: '@bee go' },
  },
};

const codexOf = (context: SessionPromptContext): SessionPromptContext => ({
  ...context,
  agentCommand: 'codex-acp',
});

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24);
}

function topicOwners<C>(sections: readonly PromptSection<C>[], surface: PromptSurface) {
  const owners = new Map<string, string[]>();
  for (const section of sections) {
    if (!section.surfaces.includes(surface)) continue;
    owners.set(section.topic, [...(owners.get(section.topic) ?? []), section.id]);
  }
  return owners;
}

describe('prompt assembly guards', () => {
  it('gives every topic exactly one owning section on each surface', () => {
    for (const surface of PROMPT_SURFACES) {
      for (const sections of [SESSION_SECTIONS, TURN_SECTIONS] as const) {
        for (const [topic, ids] of topicOwners<unknown>(
          sections as readonly PromptSection<unknown>[],
          surface,
        )) {
          expect(ids, `${surface}: topic ${topic}`).toHaveLength(1);
        }
      }
    }
  });

  it('says why every section exists', () => {
    for (const section of [...SESSION_SECTIONS, ...TURN_SECTIONS]) {
      expect(section.why.length, section.id).toBeGreaterThan(20);
    }
  });

  it('never repeats a sentence inside one assembled prompt', () => {
    for (const [name, context] of Object.entries(SESSION_VARIANTS)) {
      const seen = new Set<string>();
      for (const sentence of sentences(assembleSessionPrompt(context).systemPrompt)) {
        expect(seen.has(sentence), `${name}: "${sentence}"`).toBe(false);
        seen.add(sentence);
      }
    }
  });

  it('keeps every section, the core, and each surface inside its byte budget', () => {
    for (const [name, context] of Object.entries(SESSION_VARIANTS)) {
      const entries = sessionSections(context);
      let core = 0;
      let surface = 0;
      for (const { section, text } of entries) {
        const bytes = Buffer.byteLength(text);
        expect(bytes, `${name}: ${section.id}`).toBeLessThanOrEqual(section.budgetBytes);
        // The soul is the owner's text, not a Beeline rule, so it does not
        // count against the core ceiling.
        const ruleBytes =
          section.id === 'core.identity' && context.soul
            ? bytes - Buffer.byteLength(context.soul.instructions)
            : bytes;
        if (section.layer === 'core') core += ruleBytes;
        else surface += ruleBytes;
      }
      expect(core, `${name}: core`).toBeLessThanOrEqual(CORE_BUDGET_BYTES);
      expect(surface, `${name}: surface`).toBeLessThanOrEqual(SURFACE_BUDGET_BYTES);
    }
    for (const [name, context] of Object.entries(TURN_VARIANTS)) {
      for (const { id, bytes } of assembleTurnPrompt(context).report) {
        const section = TURN_SECTIONS.find((candidate) => candidate.id === id)!;
        expect(bytes, `${name}: ${id}`).toBeLessThanOrEqual(section.budgetBytes);
      }
    }
  });

  it('delivers every session rule to a harness that drops the session prompt', () => {
    for (const [name, context] of Object.entries(SESSION_VARIANTS)) {
      const claude = assembleSessionPrompt(context);
      expect(claude.turnPrefix, name).toBe('');
      const codex = assembleSessionPrompt(codexOf(context));
      expect(codex.turnPrefix, name).toBe(codex.systemPrompt);
      const turn = assembleTurnPrompt({
        surface: context.surface,
        sessionPrefix: codex.turnPrefix,
        task: { body: 'hello' },
      }).text;
      for (const { text } of sessionSections(codexOf(context))) {
        expect(turn, `${name}: ${text.slice(0, 40)}`).toContain(text);
      }
    }
  });

  it('states one merge condition, the one pr_checks_status enforces, and no other', () => {
    const merges = (name: string) => assembleSessionPrompt(SESSION_VARIANTS[name]!).systemPrompt;
    expect(merges('code-corner-reviewed')).toContain(
      'after its PASS the server merges the pull request itself',
    );
    expect(merges('code-corner-self-reviewer')).toContain(
      'The server merges it once checks are green, yolo is on, and no human hold stands',
    );
    for (const name of ['code-corner-reviewed', 'code-corner-self-reviewer']) {
      expect(merges(name), name).toMatch(/never merge it yourself/i);
      expect(merges(name), name).toContain('a merge GitHub refused');
    }
    for (const name of ['code-corner-reviewed-yolo-off', 'code-corner-no-reviewer']) {
      expect(merges(name), name).toContain('never merge; a person merges it');
      expect(merges(name), name).not.toContain('gh pr merge');
    }
    for (const name of Object.keys(SESSION_VARIANTS)) {
      expect(merges(name), name).not.toMatch(/approvalPending|held=false|once checks pass/);
    }
    expect(merges('code-corner-reviewed')).not.toContain('@sol');
    const review = merges('review-corner');
    expect(review).toContain('Never merge yourself');
    expect(review).not.toContain('On a checks turn');
    expect(review).not.toContain('Open the pull request');
    expect(merges('research-corner')).not.toContain('Open the pull request with gh');
  });

  it('never tells an author or reviewer to run gh pr merge', () => {
    const texts: Array<[string, string]> = [
      ...Object.entries(SESSION_VARIANTS).map(
        ([name, context]): [string, string] => [name, assembleSessionPrompt(context).systemPrompt],
      ),
      ...Object.entries(TURN_VARIANTS).map(
        ([name, context]): [string, string] => [name, assembleTurnPrompt(context).text],
      ),
      ['yolo checks nudge', CORNER_YOLO_MERGE_NUDGE],
      ['reviewer session', CORNER_REVIEWER_SESSION_INSTRUCTION],
      ...[false, true].flatMap((yolo): Array<[string, string]> => [
        [`author yolo=${yolo}`, cornerMergeInstruction(yolo, 'sol')],
        [`author no reviewer yolo=${yolo}`, cornerMergeInstruction(yolo)],
      ]),
      [
        'reviewer turn',
        cornerReviewerInstruction({
          reviewerHandle: 'sol',
          agentHandle: 'sol',
          authorHandle: 'bee',
          openedByAgent: false,
          pullRequestNumber: 7,
          headSha: 'a'.repeat(40),
          briefRevision: 2,
        })!,
      ],
      [
        'self reviewer',
        cornerSelfReviewerInstruction({
          reviewerHandle: 'sol',
          agentHandle: 'sol',
          openedByAgent: true,
        })!,
      ],
      ['using-beeline skill', usingBeelineSkillMarkdown('test')],
      ['beeline-review skill', beelineReviewSkillMarkdown('test')],
      ['beeline-spec skill', beelineSpecSkillMarkdown('test')],
      ['beeline-triage skill', beelineTriageSkillMarkdown('test')],
    ];
    for (const [name, text] of texts) {
      expect(text, name).not.toContain('gh pr merge');
      expect(text, name).not.toMatch(/approved [0-9a-f<][^`]*, merge/);
    }
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('the server merges this pull request itself');
    expect(CORNER_YOLO_MERGE_NUDGE).toContain('Never merge it yourself.');
  });

  it('keeps Workbench tools out of corners, which do not have them', () => {
    for (const [name, context] of Object.entries(SESSION_VARIANTS)) {
      const text = assembleSessionPrompt(context).systemPrompt;
      if (context.surface === 'room' || context.surface === 'dm')
        expect(text, name).toContain('workbench_status');
      else expect(text, name).not.toMatch(/workbench_status|connect_app|offer_connector/);
    }
  });

  it('keeps corner rules out of Rooms and DMs, and Room routing out of corners', () => {
    const room = assembleSessionPrompt(SESSION_VARIANTS.room!).systemPrompt;
    const dm = assembleSessionPrompt(SESSION_VARIANTS.dm!).systemPrompt;
    const corner = assembleSessionPrompt(SESSION_VARIANTS['code-corner-reviewed']!).systemPrompt;
    for (const text of [room, dm]) {
      expect(text).not.toContain('## Reproduced');
      expect(text).not.toContain('Commit and push');
      expect(text).not.toContain('pr_checks_status');
    }
    expect(dm).not.toContain('open_corner');
    expect(corner).not.toContain('open_corner');
    expect(room).toContain('open_corner');
  });

  it('carries the proactivity and finish-the-work rules on every surface', () => {
    for (const [name, context] of Object.entries(SESSION_VARIANTS)) {
      const text = assembleSessionPrompt(context).systemPrompt;
      expect(text, name).toContain('Never just restate the problem.');
      expect(text, name).toContain('Finish the work before you end the turn.');
    }
  });

  it('says a missing brief once and never asks to continue one', () => {
    const turn = assembleTurnPrompt(TURN_VARIANTS['code-corner-turn']!).text;
    expect(turn).toContain('No assigned brief');
    expect(turn).not.toContain('Continue the current assigned brief');
  });

  it('puts the trigger in the prompt once', () => {
    const turn = assembleTurnPrompt(TURN_VARIANTS['room-turn']!).text;
    expect(turn.split('Why did the release migration fail?')).toHaveLength(2);
  });
});

describe('assembled prompts', () => {
  for (const [name, context] of Object.entries(SESSION_VARIANTS)) {
    it(`snapshots the ${name} session prompt`, async () => {
      const { systemPrompt, report } = assembleSessionPrompt(context);
      const bytes = report.reduce((total, section) => total + section.bytes, 0);
      await expect(
        `<!-- Generated by apps/body/src/prompt-assembly.test.ts. Run vitest with -u to refresh. -->\n# ${name} session prompt (${bytes} bytes, ~${Math.ceil(bytes / 4)} tokens)\n\nSections: ${report.map((section) => `${section.id} ${section.bytes}B`).join(', ')}\n\n\`\`\`text\n${systemPrompt}\n\`\`\`\n`,
      ).toMatchFileSnapshot(`../../../docs/prompts/${name}.md`);
    });
  }
  for (const [name, context] of Object.entries(TURN_VARIANTS)) {
    it(`snapshots the ${name} prompt`, async () => {
      const { text, report } = assembleTurnPrompt(context);
      await expect(
        `<!-- Generated by apps/body/src/prompt-assembly.test.ts. Run vitest with -u to refresh. -->\n# ${name} prompt (Claude harness; Codex, Pi, and Grok get the session prompt above this)\n\nSections: ${report.map((section) => `${section.id} ${section.bytes}B`).join(', ')}\n\n\`\`\`text\n${text}\n\`\`\`\n`,
      ).toMatchFileSnapshot(`../../../docs/prompts/${name}.md`);
    });
  }
});
