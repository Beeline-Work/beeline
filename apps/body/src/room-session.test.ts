import { describe, expect, it } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import {
  beelineAgentMcpServer,
  readOnlyMcpServer,
  ReadOnlyToolsUnavailableError,
} from './room-session.js';

describe('monolith Room inspection mount', () => {
  it('does not expose GitHub credentials to a top-level Room session', () => {
    const server = readOnlyMcpServer(
      {
        agentBinary: 'agent',
        agentKind: 'codex',
        mcpBinary: 'unused',
        readonlyMcpCommand: '/bin/read-only',
        agentEnv: { GH_TOKEN: 'ambient-token', GITHUB_TOKEN: 'ambient-token' },
        workspaceRoot: '/room',
        autoApprovePermissions: false,
      },
      '/room',
    );

    expect(server.env).not.toContainEqual(expect.objectContaining({ name: 'GH_TOKEN' }));
    expect(server.env).not.toContainEqual(expect.objectContaining({ name: 'GITHUB_TOKEN' }));
  });

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
        {
          agentBinary: 'agent',
          mcpBinary: 'unused',
          agentEnv: {},
          workspaceRoot: '/room',
          autoApprovePermissions: false,
        },
        '/room',
      ),
    ).toThrow(ReadOnlyToolsUnavailableError);
  });

  it('mounts daemon-scoped corner controls separately from repository reads', () => {
    const api = new DaemonApiClient('https://server.example', 'daemon-secret', 'agent-id');
    const server = beelineAgentMcpServer(
      {
        agentBinary: 'agent',
        mcpBinary: 'unused',
        readonlyMcpCommand: '/bin/beeline-mcp',
        agentEnv: {},
        workspaceRoot: '/room',
        autoApprovePermissions: false,
      },
      api,
      { roomId: 'room-id', workspaceId: 'workspace-id', cornerId: 'corner-id' },
    );
    expect(server).toMatchObject({ name: 'beeline-agent', command: '/bin/beeline-mcp' });
    expect(server.env).toEqual(
      expect.arrayContaining([
        { name: 'BEELINE_MCP_SURFACE', value: 'agent' },
        { name: 'BEELINE_DAEMON_ROOM_ID', value: 'room-id' },
        { name: 'BEELINE_DAEMON_CORNER_ID', value: 'corner-id' },
        { name: 'BEELINE_DAEMON_TOKEN', value: 'daemon-secret' },
      ]),
    );
  });
});
