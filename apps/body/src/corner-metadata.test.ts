import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CORNER_OBJECTIVE_MAX_CHARS,
  CORNER_PLAN_MAX_ITEMS,
  CORNER_PLAN_STEP_MAX_CHARS,
  CORNER_TITLE_MAX_CHARS,
  cornerTitleFromTask,
  cornerMetadataPrompt,
  parseCornerMetadata,
} from './corner-metadata.js';

describe('corner metadata generation boundary', () => {
  it('gives the model bounded recent context and treats it as quoted data', () => {
    const prompt = cornerMetadataPrompt(
      '@codex open the corner',
      Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? 'agent' : 'user',
        text: `turn-${index} ${'x'.repeat(1_000)}`,
      })),
    );

    expect(prompt).toContain('"turn-8 ');
    expect(prompt).toContain('"turn-19 ');
    expect(prompt).not.toContain('turn-7 ');
    expect(prompt).toContain('untrusted conversation to summarize');
    expect(prompt).toContain('"items"');
    expect(prompt).toContain('exactly three words');
    expect(prompt).toContain('"verb"');
    expect(prompt.length).toBeLessThan(7_000);
  });

  it('accepts strict JSON and normalizes it to short plain text', () => {
    const parsed = parseCornerMetadata(
      `\`\`\`json\n${JSON.stringify({
        verb: 'improve',
        subject: 'corner',
        qualifier: 'metadata',
        objective: ` Generate a polished title\n and concise objective. ${'y'.repeat(300)}`,
        items: [
          ` Read the corner metadata path ${'z'.repeat(300)} `,
          'Update the strict JSON parser',
        ],
      })}\n\`\`\``,
    );

    expect(parsed?.title).toBe('Improve Corner Metadata');
    expect(parsed!.title.length).toBeLessThan(CORNER_TITLE_MAX_CHARS);
    expect(parsed?.objective).toHaveLength(CORNER_OBJECTIVE_MAX_CHARS);
    expect(parsed?.objective).not.toContain('\n');
    expect(parsed?.plan?.items).toEqual([
      { step: expect.stringMatching(/^Read the corner metadata path/), status: 'in_progress' },
      { step: 'Update the strict JSON parser', status: 'pending' },
    ]);
    expect(parsed?.plan?.items[0]?.step).toHaveLength(CORNER_PLAN_STEP_MAX_CHARS);
  });

  it('bounds and deduplicates the task-authored plan without requiring one', () => {
    const manyItems = Array.from(
      { length: CORNER_PLAN_MAX_ITEMS + 3 },
      (_, index) => `Task-specific step ${index}`,
    );
    expect(
      parseCornerMetadata(JSON.stringify({
        verb: 'restrict',
        subject: 'corner',
        qualifier: 'plan',
        objective: 'Keep the authored corner plan compact and safe.',
        items: [...manyItems, manyItems[0]],
      }))?.plan?.items.map((item) => item.step),
    ).toEqual(manyItems.slice(0, CORNER_PLAN_MAX_ITEMS));
    expect(
      parseCornerMetadata(JSON.stringify({
        verb: 'allow',
        subject: 'no',
        qualifier: 'plan',
        objective: 'Fall back honestly when the agent cannot author specific steps.',
      })),
    ).toEqual({
      title: 'Allow No Plan',
      objective: 'Fall back honestly when the agent cannot author specific steps.',
    });
  });

  it('rejects prose, missing fields, and implausibly empty metadata', () => {
    expect(
      parseCornerMetadata('Here is the metadata: {"verb":"fix","subject":"the","qualifier":"bug","objective":"Do it."}'),
    ).toBeUndefined();
    expect(parseCornerMetadata('{"verb":"fix","subject":"the","qualifier":"bug"}')).toBeUndefined();
    expect(parseCornerMetadata('{"verb":"invent","subject":"new","qualifier":"scope","objective":"Create a valid objective."}')).toBeUndefined();
    expect(parseCornerMetadata('{"verb":"fix","subject":"two words","qualifier":"bug","objective":"Create a valid objective."}')).toBeUndefined();
  });

  it('formats deterministic fallbacks with the same three-word verb-first grammar', () => {
    expect(cornerTitleFromTask('publish the website')).toBe('Publish The Website');
    expect(cornerTitleFromTask('make corners active')).toBe('Make Corners Active');
    expect(cornerTitleFromTask('OAuth callback retry state')).toBe('Implement OAuth Callback');
    expect(cornerTitleFromTask('')).toBe('Implement Corner Work');
  });

  it('opens with deterministic metadata and spends no hidden model turn', () => {
    const source = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');
    const open = source.slice(source.indexOf('async openSubchannel('));
    expect(open).not.toContain('modelCornerMetadata');
    expect(source).not.toContain("cause: 'corner-metadata'");
    expect(open.indexOf('cornerTitleFromTask(taskDescription)')).toBeLessThan(
      open.indexOf('await createAgentSubchannel('),
    );
  });
});
