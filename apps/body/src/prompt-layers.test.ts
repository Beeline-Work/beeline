import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { CornerBrief } from '@beeline/api-contract/daemon';
import {
  CORNER_CHECKS_NUDGE,
  CORNER_DELIVERY_NUDGE,
  CORNER_LAND_RULE,
  CORNER_REVIEWER_AUTHOR_MERGE,
  CORNER_REVIEWER_SESSION_INSTRUCTION,
  CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION,
  PROMPT_SURFACES,
  SESSION_SECTIONS,
  TURN_SECTIONS,
  cornerMergeInstruction,
  cornerReviewerInstruction,
  type SessionPromptContext,
  type TurnPromptContext,
} from './prompt-assembly.js';
import {
  beelineReviewSkillMarkdown,
  beelineSpecSkillMarkdown,
  beelineTriageSkillMarkdown,
  usingBeelineSkillMarkdown,
} from './beeline-skill.js';

/**
 * One rule, one layer. The system prompt holds the rules, a tool description
 * says what its inputs mean, and a skill covers rare mechanics. A sentence
 * written in two layers drifts: one copy is edited and the other is not.
 */

type Layer = 'prompt' | 'skill' | 'tool';

/** Tool text an agent reads: tool descriptions, tool results, and rewritten procedures. */
const TOOL_SOURCES = [
  'apps/body/src/minimal-tool-surface.ts',
  'apps/body/src/read-only-mcp.ts',
  'apps/server/src/procedure-tool-vocabulary.ts',
];

const repoRoot = resolve(import.meta.dirname, '../../..');

function sentences(text: string): string[] {
  return text
    .replace(/[`*]/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/^\s*(?:[-#>|]+\s*)+/, '').replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length > 24);
}

/** Every string a source file writes, with template holes as a line break so no sentence spans one. */
function sourceStrings(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(resolve(repoRoot, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const strings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text);
    else if (ts.isTemplateExpression(node))
      strings.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('\n'));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return strings;
}

const briefs: Record<string, CornerBrief | undefined> = {
  none: undefined,
  repository: { id: 'c', revision: 2, authorId: 'a', sourceRoomId: 'r', attachments: [], repositoryWork: true, spec: '## Intent\nFix it' },
  runtime: { id: 'c', revision: 2, authorId: 'a', sourceRoomId: 'r', attachments: [], repositoryWork: false, spec: '## Intent\nRun it' },
};

/** Every session context shape a turn loop can build, so every branch of every render is scanned. */
function sessionContexts(): SessionPromptContext[] {
  const contexts: SessionPromptContext[] = [];
  for (const surface of PROMPT_SURFACES)
    for (const brief of Object.values(briefs))
      for (const reviewer of [false, true])
        for (const githubCli of [undefined, 'rest'] as const)
          for (const android of [undefined, { emulatorPort: '5600' }, { emulatorPort: '5600', leased: true }])
            for (const shell of [undefined, { available: true } as const, { available: false, detail: 'Install bubblewrap.' } as const])
              contexts.push({
                surface, brief, reviewer, githubCli, android, shell,
                agentName: 'Bee',
                soul: { name: 'Bee', instructions: 'Be brief.' },
                machineHost: { hostname: 'chad', tailscaleName: 'chad.ts.net' },
                repository: { name: 'o/r', branch: 'main' },
                worktree: { featureBranch: 'feature/x', targetBranch: 'main' },
                reviewerHandle: reviewer ? undefined : 'sol',
                cornerPrepareScript: true,
                squireAvailable: true,
              });
  return contexts;
}

function turnContexts(): TurnPromptContext[] {
  const contexts: TurnPromptContext[] = [];
  const memory = '- Procedure workspace-core (read facet:procedure): Load at task start';
  for (const surface of PROMPT_SURFACES)
    for (const commandReason of [undefined, 'order', 'human_tag', 'corner_check', 'corner_land', 'schedule', 'subscribed_event'])
      for (const brief of [undefined, briefs.repository!, briefs.runtime!])
        for (const generatedTitle of [undefined, 'corner-abc'])
          contexts.push({
            surface, memory, generatedTitle, objective: 'Fix it',
            brief: brief && { brief, fileLines: [], missingRequiredFile: true },
            task: { body: 'Go with brief revision 1.', commandReason, reactionTargetId: 'm1' },
          });
  return contexts;
}

function promptText(): string[] {
  const texts = [
    CORNER_CHECKS_NUDGE, CORNER_DELIVERY_NUDGE, CORNER_LAND_RULE, CORNER_REVIEWER_AUTHOR_MERGE,
    CORNER_REVIEWER_SESSION_INSTRUCTION, CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION,
    cornerMergeInstruction(), cornerMergeInstruction('sol'),
    cornerReviewerInstruction({ isReviewer: true, pullRequestNumber: 7, headSha: 'abc', briefRevision: 2 })!,
  ];
  for (const context of sessionContexts())
    for (const section of SESSION_SECTIONS)
      if (section.surfaces.includes(context.surface) && (section.when?.(context) ?? true)) texts.push(section.render(context));
  for (const context of turnContexts())
    for (const section of TURN_SECTIONS)
      if (section.id !== 'turn.task' && section.surfaces.includes(context.surface) && (section.when?.(context) ?? true))
        texts.push(section.render(context));
  return texts;
}

function layerSentences(): Map<string, Map<Layer, string>> {
  const owners = new Map<string, Map<Layer, string>>();
  const add = (layer: Layer, where: string, texts: readonly string[]) => {
    for (const text of texts)
      for (const sentence of sentences(text)) {
        const key = sentence.toLowerCase();
        const places = owners.get(key) ?? new Map<Layer, string>();
        if (!places.has(layer)) places.set(layer, where);
        owners.set(key, places);
      }
  };
  add('prompt', 'apps/body/src/prompt-assembly.ts', promptText());
  for (const [name, render] of Object.entries({
    'using-beeline': usingBeelineSkillMarkdown,
    'beeline-review': beelineReviewSkillMarkdown,
    'beeline-spec': beelineSpecSkillMarkdown,
    'beeline-triage': beelineTriageSkillMarkdown,
  }))
    add('skill', `apps/body/src/beeline-skill.ts (${name})`, [render('test')]);
  for (const path of TOOL_SOURCES) add('tool', path, sourceStrings(path));
  return owners;
}

describe('one rule, one layer', () => {
  it('splits text into comparable sentences', () => {
    expect(sentences('- **Tag** to talk and order to work. Then call `report(status)` once\n## Heading that is long enough')).toEqual([
      'Tag to talk and order to work.',
      'Then call report(status) once',
      'Heading that is long enough',
    ]);
  });

  it('never writes the same sentence in more than one of prompt, skill and tool text', () => {
    const duplicates = [...layerSentences()]
      .filter(([, places]) => places.size > 1)
      .map(([sentence, places]) => `"${sentence}" in ${[...places].map(([layer, where]) => `${layer}: ${where}`).join(' and ')}`);
    expect(duplicates).toEqual([]);
  });
});
