import { describe, expect, it } from 'vitest';
import { agentToolsFor } from './read-only-mcp.js';

describe('direct message helper surface', () => {
  it('opens no corners from a direct message', () => {
    const tools = agentToolsFor(true, true);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('attach_file');
    expect(names).not.toContain('open_corner');

    // The read-only surface is untouched: it never carried daemon tools.
    const roomTools = agentToolsFor(false, true).map((tool) => tool.name);
    expect(roomTools).not.toContain('open_corner');
    expect(roomTools).not.toContain('attach_file');

    // A top-level Room keeps the bounded daemon controls.
    expect(agentToolsFor(true, false).map((tool) => tool.name)).toContain('open_corner');
  });
});
