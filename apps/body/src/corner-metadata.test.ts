import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Body, cornerOpenTaskPrompt } from './body.js';
import {
  CORNER_OBJECTIVE_MAX_CHARS,
  CORNER_PLAN_MAX_ITEMS,
  CORNER_PLAN_STEP_MAX_CHARS,
  CORNER_SUMMARY_MAX_CHARS,
  CORNER_TITLE_MAX_CHARS,
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
    expect(prompt).toContain('"summary"');
    expect(prompt.length).toBeLessThan(7_500);
  });

  it('accepts strict JSON and normalizes it to short plain text', () => {
    const parsed = parseCornerMetadata(
      `\`\`\`json\n${JSON.stringify({
        title: `  Improve\ncorner metadata ${'x'.repeat(100)}  `,
        objective: ` Generate a polished title\n and concise objective. ${'y'.repeat(300)}`,
        items: [
          ` Read the corner metadata path ${'z'.repeat(300)} `,
          'Update the strict JSON parser',
        ],
        summary: ` The Room asked for polished corner metadata\n because vague commands produce poor labels. ${'z'.repeat(700)}`,
      })}\n\`\`\``,
    );

    expect(parsed?.title).toHaveLength(CORNER_TITLE_MAX_CHARS);
    expect(parsed?.title).not.toContain('\n');
    expect(parsed?.objective).toHaveLength(CORNER_OBJECTIVE_MAX_CHARS);
    expect(parsed?.objective).not.toContain('\n');
    expect(parsed?.plan?.items).toEqual([
      { step: expect.stringMatching(/^Read the corner metadata path/), status: 'in_progress' },
      { step: 'Update the strict JSON parser', status: 'pending' },
    ]);
    expect(parsed?.plan?.items[0]?.step).toHaveLength(CORNER_PLAN_STEP_MAX_CHARS);
    expect(parsed?.summary).toHaveLength(CORNER_SUMMARY_MAX_CHARS);
    expect(parsed?.summary).not.toContain('\n');
  });

  it('bounds and deduplicates the task-authored plan without requiring one', () => {
    const manyItems = Array.from(
      { length: CORNER_PLAN_MAX_ITEMS + 3 },
      (_, index) => `Task-specific step ${index}`,
    );
    expect(
      parseCornerMetadata(JSON.stringify({
        title: 'Bound the plan',
        objective: 'Keep the authored corner plan compact and safe.',
        summary: 'The Room asked for a compact, honest plan alongside polished metadata.',
        items: [...manyItems, manyItems[0]],
      }))?.plan?.items.map((item) => item.step),
    ).toEqual(manyItems.slice(0, CORNER_PLAN_MAX_ITEMS));
    expect(
      parseCornerMetadata(JSON.stringify({
        title: 'Allow no plan',
        objective: 'Fall back honestly when the agent cannot author specific steps.',
        summary: 'The conversation is too vague to author specific implementation steps.',
      })),
    ).toEqual({
      title: 'Allow no plan',
      objective: 'Fall back honestly when the agent cannot author specific steps.',
      summary: 'The conversation is too vague to author specific implementation steps.',
    });
  });

  it('rejects prose, missing fields, and implausibly empty metadata', () => {
    expect(
      parseCornerMetadata(
        'Here is the metadata: {"title":"Fix it","objective":"Do it.","summary":"A summary."}',
      ),
    ).toBeUndefined();
    expect(parseCornerMetadata('{"title":"Fix it"}')).toBeUndefined();
    expect(parseCornerMetadata('{"title":"x","objective":"too short"}')).toBeUndefined();
    // A missing or too-short summary is a failed generation, not a partial
    // success: the whole point of the field is replacing the transcript dump.
    expect(
      parseCornerMetadata(
        '{"title":"Fix the thing","objective":"Repair the merge approval path.","summary":"too short"}',
      ),
    ).toBeUndefined();
  });

  it('runs through the hidden generator seam without publishing its answer', async () => {
    let receivedPrompt = '';
    const body = new Body(
      {
        agentBinary: '/unused',
        mcpBinary: '/unused',
        agentEnv: {},
        workspaceRoot: '/tmp/buzzy-corner-metadata-test',
        relayBaseUrl: 'http://relay.test',
        relayHost: 'relay.test',
        relayScheme: 'http',
        relayWsUrl: 'ws://relay.test',
        autoApprovePermissions: true,
      },
      undefined,
      undefined,
      undefined,
      {
        generateCornerMetadata: async (prompt) => {
          receivedPrompt = prompt;
          return JSON.stringify({
            title: 'Improve corner metadata',
            objective:
              'Generate a polished title and concise objective from Room context.',
            summary:
              'The Room discussed vague corner names and asked for model-generated metadata instead of raw request text.',
            items: ['Trace the metadata turn', 'Parse its task-authored plan', 'Cover the safe fallback'],
          });
        },
      },
    );

    const metadata = await Reflect.get(body, 'modelCornerMetadata').call(
      body,
      'room-id',
      '/tmp/unused',
      {
        eventId: 'request-id',
        authorPubkey: 'person',
        content: '@codex open the corner',
        createdAt: 1,
      },
      [{ role: 'user', text: 'make corner titles concise' }],
    );

    expect(metadata).toEqual({
      title: 'Improve corner metadata',
      objective: 'Generate a polished title and concise objective from Room context.',
      summary:
        'The Room discussed vague corner names and asked for model-generated metadata instead of raw request text.',
      plan: {
        objective: 'Generate a polished title and concise objective from Room context.',
        items: [
          { step: 'Trace the metadata turn', status: 'in_progress' },
          { step: 'Parse its task-authored plan', status: 'pending' },
          { step: 'Cover the safe fallback', status: 'pending' },
        ],
      },
    });
    expect(receivedPrompt).toContain('make corner titles concise');
  });

  it('seeds the corner\'s first turn with the generated summary, not the transcript', () => {
    const transcript = [
      { role: 'user', text: 'the merge approval path is broken', eventId: 'e1' },
      { role: 'agent', text: 'I can look into it', eventId: 'e2' },
    ];
    const withSummary = cornerOpenTaskPrompt(transcript, 'open a corner', 'e3', {
      summary: 'The Room diagnosed a broken merge approval path and asked for a fix.',
    });
    expect(withSummary).toContain('host-generated summary');
    expect(withSummary).toContain('The Room diagnosed a broken merge approval path');
    // The verbatim dump is exactly what this replaces — it must not ride along.
    expect(withSummary).not.toContain('merge approval path is broken');

    const withoutSummary = cornerOpenTaskPrompt(transcript, 'open a corner', 'e3');
    expect(withoutSummary).toContain('Recent Room transcript');
    expect(withoutSummary).toContain('merge approval path is broken');
  });

  it('keeps the production metadata session tool-free and ahead of channel creation', () => {
    const source = readFileSync(fileURLToPath(new URL('./body.ts', import.meta.url)), 'utf8');
    const generator = source.slice(source.indexOf('private async modelCornerMetadata('));
    const method = generator.slice(0, generator.indexOf('\n  }\n') + 5);
    expect(method).toContain('mcpServers: []');
    expect(method).toContain("permissionHandler: async () => 'reject'");
    expect(method).not.toContain('postAgentMessage');

    const open = source.slice(source.indexOf('async openSubchannel('));
    expect(open.indexOf('await this.modelCornerMetadata(')).toBeLessThan(
      open.indexOf('await createAgentSubchannel('),
    );
  });

  it('publishes a visible fallback notice when generation produced nothing', () => {
    const source = readFileSync(fileURLToPath(new URL('./body.ts', import.meta.url)), 'utf8');
    const open = source.slice(source.indexOf('async openSubchannel('));
    const body = open.slice(0, open.indexOf('\n  }\n'));
    // The failure is user-visible on the corner's own channel, not just a log
    // line — and only when a generation attempt actually ran.
    expect(body).toContain("request && !generated");
    expect(body).toContain("'corner-metadata-notice'");
    // The generated summary reaches both consumers of the old transcript dump.
    expect(body).toContain('generated?.summary,');
    const promptFn = source.slice(
      source.indexOf('export function cornerOpenTaskPrompt('),
      source.indexOf('/** Detect the narrow human command'),
    );
    expect(promptFn).toContain('options?: { summary?: string }');
  });
});
