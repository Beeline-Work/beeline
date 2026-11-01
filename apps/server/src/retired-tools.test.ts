import { expect, it } from 'vitest';
import { MCP_AGENT_EXCLUSIONS, MCP_AGENT_TOOLS, MCP_APP_ROUTE_OPERATIONS } from './rooms-mcp-agent.js';

it('keeps retired app operations out of external AI discovery and exclusions', () => {
  const retired = ['corner', 'app'].join('_');
  for (const name of [...Object.keys(MCP_AGENT_EXCLUSIONS), ...MCP_AGENT_TOOLS.map(tool => tool.name), ...MCP_APP_ROUTE_OPERATIONS]) {
    expect(name).not.toContain(retired);
  }
});
