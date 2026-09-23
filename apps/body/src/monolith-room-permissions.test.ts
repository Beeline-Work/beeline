import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpPermissionRequest } from './acp.js';
import { commandFixtureApi } from './command-fixture.test-support.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  GROK_NATIVE_SEARCH_TOOL_PERMISSION,
  GROK_USE_TOOL_OPEN_CORNER_PERMISSION,
  GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL_UPDATE,
} from './fixtures/grok-use-tool-permissions.js';
import { MonolithRoomTurnLoop, roomMcpPermissionDecision } from './monolith-room-turn.js';
import {
  isMountedMcpToolPermissionRequest,
  resolveMountedMcpToolCall,
} from './read-only-policy.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SessionScheduler } from './session-scheduler.js';

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
    // CodeGraph follows the same mounted-MCP policy through codex and Claude.
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'execute',
          title: 'mcp.codegraph.codegraph_explore',
          rawInput: { server: 'codegraph', tool: 'codegraph_explore', arguments: {} },
        },
      }),
    ).toBe('allow');
    expect(
      roomMcpPermissionDecision({
        toolCall: { kind: 'other', title: 'mcp__codegraph__codegraph_explore', rawInput: {} },
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
    expect(
      roomMcpPermissionDecision({
        toolCall: {
          kind: 'other',
          title: 'WebFetch(https://example.com)',
          rawInput: { url: 'https://example.com' },
        },
      }),
    ).toBe('reject');
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
      for (const tool of ['post_artifact', 'pr_checks_status', 'request_grant']) {
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
      expect(
        roomMcpPermissionDecision(
          {
            toolCall: {
              title: 'use_tool',
              rawInput: {
                tool_name: 'codegraph__codegraph_explore',
                tool_input: { query: 'trace a flow' },
              },
            },
          },
          ['beeline-readonly-mcp', 'beeline-agent', 'codegraph'],
        ),
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

    it('refuses a host-classified server, not only the literal name squire', () => {
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
      expect(
        roomMcpPermissionDecision({
          toolCall: {
            kind: 'execute',
            title: 'mcp.browser.read',
            rawInput: { server: 'browser', tool: 'read', arguments: {} },
          },
        }),
      ).toBe('allow');
      expect(
        roomMcpPermissionDecision(
          {
            toolCall: {
              kind: 'execute',
              title: 'mcp.browser.read',
              rawInput: { server: 'browser', tool: 'read', arguments: {} },
            },
          },
          undefined,
          ['browser'],
        ),
      ).toBe('reject');
      expect(
        roomMcpPermissionDecision(
          {
            toolCall: {
              kind: 'execute',
              title: 'mcp.squire.use_credential',
              rawInput: { server: 'squire', tool: 'use_credential', arguments: {} },
            },
          },
          undefined,
          [],
        ),
      ).toBe('allow');
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

/**
 * The wiring, not the predicate: a granted host route only becomes callable if
 * the turn loop hands the matcher the names this session actually mounted.
 * grok is the harness that proves it — it routes every MCP call through its
 * own `use_tool` dispatcher, so the qualified name resolves against the
 * mounted list alone (C90). A unit case over `roomMcpPermissionDecision` with
 * the name supplied by hand passes whether or not the loop supplies it.
 */
describe('a granted host route reaches the permission matcher', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const AGENT_HEX = '11'.repeat(32);
  const HUMAN = '22'.repeat(32);

  async function capturedHandler(
    grants: Array<{ kind: string; target: string; status?: string }>,
    authorizeAllowed = true,
  ): Promise<(request: AcpPermissionRequest) => Promise<boolean>> {
    const root = await mkdtemp(join(tmpdir(), 'beeline-granted-route-'));
    roots.push(root);
    const operatorHome = join(root, 'operator-home');
    await mkdir(join(operatorHome, '.grok'), { recursive: true });
    await writeFile(
      join(operatorHome, '.grok/config.toml'),
      [
        '[mcp_servers.squire]',
        'command = "npx"',
        'args = ["-y", "@trusty-squire/mcp@latest", "server"]',
        '[mcp_servers.vault]',
        'command = "npx"',
        'args = ["-y", "@trusty-squire/mcp@latest", "server"]',
        '[mcp_servers.broker]',
        'command = "custom-facade"',
        '[mcp_servers.broker.env]',
        'TRUSTY_SQUIRE_BROKER_SOCKET = "/home/op/.trusty-squire/broker.sock"',
        '',
      ].join('\n'),
      'utf8',
    );

    const identity = identityFromKey(AGENT_HEX, 'Bee');
    const agent = {
      name: 'Bee',
      publicKey: identity.publicKey,
      secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    };
    const runtime = {
      agent,
      rooms: [],
      supervisorRoot: root,
      transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
      agentBinary: '/fake-agent',
      agentKind: 'grok',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
    } as unknown as AgentRuntimeRecord;
    const config = {
      agentBinary: '/fake-agent',
      agentKind: 'grok',
      agentCommand: '/fake-agent',
      agentArgs: [],
      mcpBinary: '/fake-dev-mcp',
      readonlyMcpCommand: '/fake-beeline-mcp',
      agentEnv: {},
      workspaceRoot: join(root, 'room'),
      autoApprovePermissions: true,
      accessPolicy: 'everyone',
      agentHomeRoot: join(root, 'agent-home'),
      operatorHome,
    } as BodyConfig;

    let inboxReads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentConfiguration') return { commands: [], yoloMode: false };
      if (name === 'getRoomRepositoryState') return { resolution: 'none' };
      if (name === 'listAgentGrants') return { grants };
      if (name === 'authorizeSquireCall') return { allowed: authorizeAllowed };
      if (name === 'getWorkspaceRoster') {
        return {
          members: [
            { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
            { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
          ],
        };
      }
      if (name === 'getRoomInbox') {
        inboxReads += 1;
        if (inboxReads === 2) {
          return {
            items: [
              {
                id: 'ask-1',
                authorId: HUMAN,
                createdAt: 1,
                type: 'message',
                body: 'use the vault',
                attachments: [],
              },
            ],
            cursor: 'ask-1',
          };
        }
        return { items: [], cursor: 'latest' };
      }
      if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
      if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
      return { id: 'write-id', createdAt: 1 };
    });
    const api = {
      execute,
      connection: () => ({
        baseUrl: 'https://server.example',
        daemonToken: 'daemon-token',
        agentId: agent.publicKey,
      }),
    } as unknown as DaemonApiClient;

    const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
    vi.spyOn(acp, 'start').mockResolvedValue(undefined);
    vi.spyOn(acp, 'sessionNew').mockResolvedValue({ sessionId: 'room-session', raw: {} });
    vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(false);
    const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'done',
      toolCalls: [],
    });

    let handler: ((request: AcpPermissionRequest) => Promise<'allow' | 'reject'>) | undefined;
    const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
    const abort = new AbortController();
    const loop = new MonolithRoomTurnLoop({
      roomId: 'room-id',
      workspaceId: 'workspace',
      cwd: config.workspaceRoot,
      runtime,
      config,
      api: commandFixtureApi(api, 'room-id', agent.publicKey),
      scheduler,
      health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
      signal: abort.signal,
      pollMs: 10,
      createAcpClient: (options: ConstructorParameters<typeof AcpClient>[0]) => {
        handler = options.permissionHandler;
        return acp;
      },
    }).run();
    await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalled(), { timeout: 5_000 });
    abort.abort();
    await loop;
    await scheduler.dispose();
    expect(handler).toBeDefined();
    return async (request) => (await handler!(request)) === 'allow';
  }

  const grokUseTool: AcpPermissionRequest = {
    toolCall: {
      title: 'use_tool',
      rawInput: {
        tool_name: 'squire__use_credential',
        tool_input: { service: 'openai' },
      },
    },
  };

  it("approves grok's use_tool spelling of a route the owner granted", async () => {
    const allow = await capturedHandler([{ kind: 'mcp', target: 'squire', status: 'approved' }]);
    expect(await allow(grokUseTool)).toBe(true);
  });

  it('keeps refusing the same call with no grant', async () => {
    const allow = await capturedHandler([]);
    expect(await allow(grokUseTool)).toBe(false);
  });

  it('refuses a mounted Squire call when the turn requester has no applicable approval', async () => {
    const allow = await capturedHandler(
      [{ kind: 'mcp', target: 'squire', status: 'approved' }],
      false,
    );
    expect(await allow(grokUseTool)).toBe(false);
  });

  it('gates an aliased Squire route mounted through the same façade', async () => {
    const aliasCall: AcpPermissionRequest = {
      toolCall: {
        title: 'use_tool',
        rawInput: { tool_name: 'vault__use_credential', tool_input: { service: 'openai' } },
      },
    };
    const allow = await capturedHandler(
      [{ kind: 'mcp', target: 'vault', status: 'approved' }],
      false,
    );
    expect(await allow(aliasCall)).toBe(false);
    const approved = await capturedHandler([{ kind: 'mcp', target: 'vault', status: 'approved' }]);
    expect(await approved(aliasCall)).toBe(true);
  });

  it('gates an alias identified by its broker environment', async () => {
    const allow = await capturedHandler([{ kind: 'mcp', target: 'broker', status: 'approved' }], false);
    expect(
      await allow({
        toolCall: {
          title: 'mcp.broker.use_credential',
          rawInput: { server: 'broker', tool: 'use_credential' },
        },
      }),
    ).toBe(false);
  });
});
