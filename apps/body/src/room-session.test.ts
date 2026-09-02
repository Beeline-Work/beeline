import { describe, expect, it } from 'vitest';
import { readOnlyMcpServer, ReadOnlyToolsUnavailableError } from './room-session.js';

describe('monolith Room inspection mount', () => {
  it('mounts only the bounded read-only MCP at the Room root', () => {
    const server = readOnlyMcpServer(
      {
        agentBinary: 'agent',
        mcpBinary: 'unused',
        readonlyMcpCommand: '/bin/read-only',
        readonlyMcpArgs: ['--stdio'],
        agentEnv: {},
        workspaceRoot: '/room',
        autoApprovePermissions: false,
      },
      '/room',
    );
    expect(server).toMatchObject({ name: 'beeline-readonly-mcp', command: '/bin/read-only' });
    expect(server.env).toContainEqual({ name: 'BEELINE_READONLY_ROOT', value: '/room' });
  });

  it('fails closed when the helper is absent', () => {
    expect(() =>
      readOnlyMcpServer(
        { agentBinary: 'agent', mcpBinary: 'unused', agentEnv: {}, workspaceRoot: '/room', autoApprovePermissions: false },
        '/room',
      ),
    ).toThrow(ReadOnlyToolsUnavailableError);
  });
});
