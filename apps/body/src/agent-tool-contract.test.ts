import { describe, expect, it } from 'vitest';
import {
  BEELINE_AGENT_TOOL_DEFINITIONS,
  BEELINE_AGENT_TOOL_NAMES,
  assertBeelineAgentToolHandshake,
} from './agent-tool-contract.js';

describe('Beeline agent tool contract', () => {
  it('advertises exactly open_corner and the repo-less close verb', () => {
    expect(BEELINE_AGENT_TOOL_NAMES).toEqual(['open_corner', 'close_corner']);
    expect(BEELINE_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(
      BEELINE_AGENT_TOOL_NAMES,
    );
    expect(
      BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'close_corner')?.description,
    ).toContain('repository-less');
  });

  it('keeps both tool schemas closed and host-scoped', () => {
    const open = BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'open_corner')!;
    const close = BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'close_corner')!;
    expect(open.inputSchema).toMatchObject({
      required: ['objective'],
      additionalProperties: false,
    });
    expect(close.inputSchema).toMatchObject({
      required: ['corner_id'],
      additionalProperties: false,
    });
  });

  it('fails closed on an older inventory', () => {
    expect(() =>
      assertBeelineAgentToolHandshake({
        serverInfo: { name: 'beeline-agent-tools', version: '4' },
        toolNames: ['open_corner', 'close_corner', 'merge_pr'],
      }),
    ).toThrow('inventory handshake failed');
  });
});
