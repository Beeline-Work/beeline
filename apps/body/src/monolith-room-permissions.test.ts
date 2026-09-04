import { describe, expect, it } from 'vitest';
import {
  GROK_NATIVE_SEARCH_TOOL_PERMISSION,
  GROK_USE_TOOL_OPEN_CORNER_PERMISSION,
  GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL_UPDATE,
} from './fixtures/grok-use-tool-permissions.js';
import { roomMcpPermissionDecision } from './monolith-room-turn.js';
import {
  isMountedMcpToolPermissionRequest,
  resolveMountedMcpToolCall,
} from './read-only-policy.js';

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

  /**
   * grok never asks about an MCP tool by name: every call rides its native
   * `use_tool` dispatcher, so the request says `use_tool` and names the real
   * tool only inside the envelope, as `<server>__<tool>` with no `mcp` marker
   * anywhere (C90). The decision reads that identity, not the wrapper shape.
   */
  describe("grok's use_tool envelope", () => {
    it('allows a mounted server named inside the envelope, captured verbatim', () => {
      expect(roomMcpPermissionDecision(GROK_USE_TOOL_OPEN_CORNER_PERMISSION)).toBe('allow');
      expect(
        resolveMountedMcpToolCall(GROK_USE_TOOL_OPEN_CORNER_PERMISSION, [
          'beeline-readonly-mcp',
          'beeline-agent',
        ]),
      ).toEqual({ server: 'beeline-agent', tool: 'open_corner' });
    });

    it('allows the relabelled follow-up title for the same call', () => {
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            kind: GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL_UPDATE.kind,
            title: GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL_UPDATE.title,
            rawInput: GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL_UPDATE.rawInput,
          },
        }),
      ).toBe('allow');
    });

    it('allows every other tool on a mounted server, not just the corner opener', () => {
      for (const tool of ['attach_file', 'pr_checks_status', 'request_grant']) {
        expect(
          roomMcpPermissionDecision({
            toolCall: {
              title: 'use_tool',
              rawInput: { tool_name: `beeline-agent__${tool}`, tool_input: {} },
            },
          }),
        ).toBe('allow');
      }
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            title: 'use_tool',
            rawInput: { tool_name: 'beeline-readonly-mcp__read_file', tool_input: { path: 'a' } },
          },
        }),
      ).toBe('allow');
    });

    it('refuses the same envelope naming a server this session never mounted', () => {
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            title: 'use_tool',
            rawInput: { tool_name: 'files-mcp__read_file', tool_input: { path: 'README.md' } },
          },
        }),
      ).toBe('reject');
      // …and it is the mounted list that decides, not the name: mount it and
      // the identical request resolves.
      expect(
        roomMcpPermissionDecision(
          {
            toolCall: {
              title: 'use_tool',
              rawInput: { tool_name: 'files-mcp__read_file', tool_input: { path: 'README.md' } },
            },
          },
          ['beeline-agent', 'files-mcp'],
        ),
      ).toBe('allow');
    });

    it('refuses a shell payload smuggled inside the envelope', () => {
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            title: 'use_tool',
            rawInput: {
              tool_name: 'beeline-agent__open_corner',
              tool_input: { command: 'rm -rf /' },
            },
          },
        }),
      ).toBe('reject');
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            title: 'beeline-agent__open_corner',
            rawInput: { tool_name: 'beeline-agent__open_corner', tool_input: 'rm -rf /' },
          },
        }),
      ).toBe('reject');
    });

    it('refuses Trusty Squire inside the envelope, before any allow rule', () => {
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            title: 'use_tool',
            rawInput: { tool_name: 'squire__use_credential', tool_input: {} },
          },
        }),
      ).toBe('reject');
      expect(roomMcpPermissionDecision({ toolCall: { title: 'squire__use_credential' } })).toBe(
        'reject',
      );
    });

    it("refuses grok's own native tools, captured from the same turn", () => {
      expect(roomMcpPermissionDecision(GROK_NATIVE_SEARCH_TOOL_PERMISSION)).toBe('reject');
    });

    it('refuses a request it cannot positively resolve to a mounted tool', () => {
      // A qualified-looking name whose tool half is a command line, not a name.
      expect(
        roomMcpPermissionDecision({
          toolCall: { title: 'beeline-agent open_corner; rm -rf /' },
        }),
      ).toBe('reject');
      expect(
        roomMcpPermissionDecision({
          toolCall: { title: 'use_tool', rawInput: { tool_name: 'open_corner', tool_input: {} } },
        }),
      ).toBe('reject');
      expect(roomMcpPermissionDecision({ toolCall: { title: 'use_tool' } })).toBe('reject');
      expect(roomMcpPermissionDecision({})).toBe('reject');
    });
  });
});
