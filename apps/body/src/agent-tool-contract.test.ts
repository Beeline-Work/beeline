import { describe, expect, it } from 'vitest';
import {
  BEELINE_AGENT_TOOL_DEFINITIONS,
  BEELINE_AGENT_TOOL_NAMES,
  cornerFrozenForPendingClose,
} from './agent-tool-contract.js';

describe('Beeline Phase-1 tool contract', () => {
  it('advertises exactly the four Phase-1 verbs and both artifact input modes', () => {
    expect(BEELINE_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(
      BEELINE_AGENT_TOOL_NAMES,
    );
    const deliver = BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'deliver');
    expect(deliver?.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(deliver?.inputSchema.oneOf as unknown[]).toHaveLength(2);
  });

  it('freezes the exact pending close until a verified approval advances it', () => {
    const pending = {
      turnId: 'turn',
      sourceSha: 'a'.repeat(40),
      targetRef: 'refs/heads/main',
      requestId: 'request',
      eventId: 'event',
    };
    expect(cornerFrozenForPendingClose({ pending })).toBe(true);
    expect(cornerFrozenForPendingClose({ pending, approved: true })).toBe(false);
    expect(cornerFrozenForPendingClose({})).toBe(false);
  });
});
