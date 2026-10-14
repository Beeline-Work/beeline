import { expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { agentToolsFor } from './read-only-mcp.js';

it('Reproduction report-schema: accepts complete multi-paragraph reports on every surface', () => {
  const text = 'blocked: ' + 'Synthetic paragraph for report delivery.\n\n'.repeat(150);
  for (const tools of [agentToolsFor(true, false), agentToolsFor(true, true), agentToolsFor(true, false, true)]) {
    const schema = tools.find(tool => tool.name === 'report')!.inputSchema;
    expect(Check(schema, { status: 'blocked', text })).toBe(true);
    // Constrained generation clients may require patterns to match the entire value.
    expect(schema.properties.text).not.toHaveProperty('pattern');
    expect(Check(schema, { status: 'blocked', text: 'blocked: ' + 'x'.repeat(16000) })).toBe(false);
  }
  console.info(`Demonstrated report-schema: shipped schemas accept all ${text.length} characters across multiple paragraphs`);
});
