import { describe, expect, it } from 'vitest';
import { roomMcpPermissionDecision } from './monolith-room-turn.js';
import { isMountedMcpToolPermissionRequest } from './read-only-policy.js';

describe('top-level Room MCP permission policy', () => {
  it('allows every mounted MCP tool call, host or operator', () => {
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
          rawInput: {
            server: 'beeline-agent',
            tool: 'open_corner',
            arguments: { objective: 'Fix it.' },
          },
        },
      }),
    ).toBe('allow');
    // An ordinary operator MCP server copied into the isolated home: same rule.
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.files-mcp.read_file',
          rawInput: { server: 'files-mcp', tool: 'read_file', arguments: { path: 'README.md' } },
        },
      }),
    ).toBe('allow');
    // claude-agent-acp's title-only spelling of a non-Beeline MCP call.
    expect(
      roomMcpPermissionDecision({
        toolCall: { kind: 'other', title: 'mcp__files-mcp__read_file', rawInput: {} },
      }),
    ).toBe('allow');
  });

  it('rejects anything that is not an MCP tool call', () => {
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
        toolCall: { kind: 'execute', title: 'Bash', rawInput: { command: 'ls' } },
      }),
    ).toBe('reject');
    expect(roomMcpPermissionDecision({ toolCall: { kind: 'other', title: 'WebSearch' } })).toBe(
      'reject',
    );
  });

  it('still refuses the host-brokered Trusty Squire surface', () => {
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.squire.use_credential',
          rawInput: { server: 'squire', tool: 'use_credential' },
        },
      }),
    ).toBe('reject');
  });

  it('classifies MCP calls structurally without trusting titles for shells', () => {
    expect(isMountedMcpToolPermissionRequest({})).toBe(false);
    expect(
      isMountedMcpToolPermissionRequest({
        toolCall: { kind: 'execute', title: 'ls', rawInput: 'ls -la' },
      }),
    ).toBe(false);
    expect(
      isMountedMcpToolPermissionRequest({
        toolCall: { kind: 'execute', title: 'mcp__x__y', rawInput: { command: 'ls' } },
      }),
    ).toBe(false);
    expect(
      isMountedMcpToolPermissionRequest({
        toolCall: { kind: 'execute', title: 'mcp__x__y' },
      }),
    ).toBe(true);
  });
});
