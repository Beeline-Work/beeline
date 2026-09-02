import { describe, expect, it } from 'vitest';
import { roomMcpPermissionDecision } from './monolith-room-turn.js';

describe('top-level Room MCP permission policy', () => {
  it('allows only the two host-mounted MCP surfaces', () => {
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.beeline-readonly-mcp.search_text',
          rawInput: {
            server: 'beeline-readonly-mcp',
            tool: 'search_text',
            arguments: { query: 'workspaceRoot' },
          },
        },
      }),
    ).toBe('allow');
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.beeline-agent.open_corner',
          rawInput: { server: 'beeline-agent', tool: 'open_corner', arguments: { summary: 'Fix it.' } },
        },
      }),
    ).toBe('allow');
  });

  it('rejects shell, filesystem, and unmounted MCP requests', () => {
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.beeline-readonly-mcp.search_text',
          rawInput: { command: 'rm -rf /tmp' },
        },
      }),
    ).toBe('reject');
    expect(
      roomMcpPermissionDecision({ toolCall: { kind: 'read', title: 'Read /etc/passwd' } }),
    ).toBe('reject');
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.other-server.search_text',
          rawInput: { server: 'other-server', tool: 'search_text' },
        },
      }),
    ).toBe('reject');
  });
});
