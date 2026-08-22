import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Body } from './body.js';
import {
  CORNER_OBJECTIVE_MAX_CHARS,
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
    expect(prompt.length).toBeLessThan(7_000);
  });

  it('accepts strict JSON and normalizes it to short plain text', () => {
    const parsed = parseCornerMetadata(
      `\`\`\`json\n${JSON.stringify({
        title: `  Improve\ncorner metadata ${'x'.repeat(100)}  `,
        objective: ` Generate a polished title\n and concise objective. ${'y'.repeat(300)}`,
      })}\n\`\`\``,
    );

    expect(parsed?.title).toHaveLength(CORNER_TITLE_MAX_CHARS);
    expect(parsed?.title).not.toContain('\n');
    expect(parsed?.objective).toHaveLength(CORNER_OBJECTIVE_MAX_CHARS);
    expect(parsed?.objective).not.toContain('\n');
  });

  it('rejects prose, missing fields, and implausibly empty metadata', () => {
    expect(
      parseCornerMetadata('Here is the metadata: {"title":"Fix it","objective":"Do it."}'),
    ).toBeUndefined();
    expect(parseCornerMetadata('{"title":"Fix it"}')).toBeUndefined();
    expect(parseCornerMetadata('{"title":"x","objective":"too short"}')).toBeUndefined();
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
          return '{"title":"Improve corner metadata","objective":"Generate a polished title and concise objective from Room context."}';
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
    });
    expect(receivedPrompt).toContain('make corner titles concise');
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
});
