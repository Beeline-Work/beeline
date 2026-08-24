import { describe, expect, it, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { AcpClient } from './acp.js';
import {
  CLAUDE_TOOL_SCOPE_SETTINGS,
  NO_PERSONAL_CONNECTORS_INSTRUCTION,
  harnessReadsMetaSystemPrompt,
  harnessToolScope,
  sessionToolScopeMeta,
  toolScopeWarning,
} from './harness-tool-scope.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A fake ACP agent installed under a chosen basename, so `harnessToolScope`'s
 * command matching sees the real thing rather than a stub. It writes the exact
 * `session/new` params it received to `$SCOPE_CAPTURE`.
 */
async function fakeAgentNamed(basename: string): Promise<{ binary: string; capture: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-tool-scope-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, basename);
  const capture = resolve(directory, 'session-new.json');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    writeFileSync(process.env.SCOPE_CAPTURE, JSON.stringify(message.params));
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'scope-session' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return { binary, capture };
}

async function capturedSessionNew(basename: string): Promise<Record<string, unknown>> {
  const { binary, capture } = await fakeAgentNamed(basename);
  const client = new AcpClient({ agentCommand: binary, agentEnv: { SCOPE_CAPTURE: capture } });
  await client.start();
  try {
    await client.sessionNew({
      cwd: tmpdir(),
      mcpServers: [{ name: 'buzz-readonly-mcp', command: '/bin/true' }],
      systemPrompt: 'Beeline room boundary.',
    });
  } finally {
    await client.stop();
  }
  return JSON.parse(await readFile(capture, 'utf8')) as Record<string, unknown>;
}

describe('harnessToolScope', () => {
  it('classifies each verified harness by whether the daemon can confine its tool surface', () => {
    expect(harnessToolScope('/usr/local/bin/claude-agent-acp').enforcement).toBe('config-isolated');
    expect(harnessToolScope('buzz-agent').enforcement).toBe('allowlisted');
    expect(harnessToolScope('codex-acp').enforcement).toBe('config-isolated');
    expect(harnessToolScope('/home/op/.grok/bin/grok').enforcement).toBe('config-isolated');
    expect(harnessToolScope('pi-acp').enforcement).toBe('none');
  });

  it('fails closed on an unverified or missing command', () => {
    expect(harnessToolScope('some-new-agent').enforcement).toBe('unknown');
    expect(harnessToolScope(undefined).enforcement).toBe('unknown');
  });
});

describe('sessionToolScopeMeta', () => {
  it('loads only isolated user MCP and kills claude.ai connectors', () => {
    // Owner decision 2026-08-23: agents get every skill + MCP on the host, so
    // `strictMcpConfig` (ignore all config-file MCP) is deliberately NOT sent;
    // user-only settings plus the connector kill switch ride `_meta` now.
    const meta = sessionToolScopeMeta('claude-agent-acp') as {
      claudeCode: {
        options: { strictMcpConfig?: boolean; settingSources: string[]; settings: string };
      };
    };
    expect(meta.claudeCode.options.strictMcpConfig).toBeUndefined();
    expect(meta.claudeCode.options.settingSources).toEqual(['user']);
    // The adapter forwards `settings` to the CLI's `--settings`, which takes a
    // JSON string; an object would stringify to "[object Object]".
    expect(typeof meta.claudeCode.options.settings).toBe('string');
    expect(JSON.parse(meta.claudeCode.options.settings)).toEqual(CLAUDE_TOOL_SCOPE_SETTINGS);
    expect(CLAUDE_TOOL_SCOPE_SETTINGS.disableClaudeAiConnectors).toBe(true);
  });

  it('never lets a caller mutate the profile shared with every later session', () => {
    const first = sessionToolScopeMeta('claude-agent-acp') as {
      claudeCode: { options: Record<string, unknown> };
    };
    first.claudeCode.options.settings = '{}';
    const second = sessionToolScopeMeta('claude-agent-acp') as {
      claudeCode: { options: Record<string, unknown> };
    };
    expect(second.claudeCode.options.settings).not.toBe('{}');
  });

  it('has nothing to send for a harness with no session-level allowlist', () => {
    expect(sessionToolScopeMeta('codex-acp')).toBeUndefined();
    expect(sessionToolScopeMeta('pi-acp')).toBeUndefined();
    expect(sessionToolScopeMeta('buzz-agent')).toBeUndefined();
    expect(sessionToolScopeMeta(undefined)).toBeUndefined();
  });
});

describe('harnessReadsMetaSystemPrompt', () => {
  it('is true only for the adapter that ignores the top-level systemPrompt field', () => {
    expect(harnessReadsMetaSystemPrompt('claude-agent-acp')).toBe(true);
    expect(harnessReadsMetaSystemPrompt('codex-acp')).toBe(false);
    expect(harnessReadsMetaSystemPrompt('buzz-agent')).toBe(false);
  });
});

describe('toolScopeWarning', () => {
  it('warns for a claude Room without its own harness home, like codex', () => {
    // Claude's tool surface is scoped by the isolated CLAUDE_CONFIG_DIR since
    // strictMcpConfig was dropped, so the warning applies to it too.
    expect(
      toolScopeWarning('claude-agent-acp', { isolatedHarnessHome: false }),
    ).toMatch(/CLAUDE_CONFIG_DIR|BUZZY_BODY_ROOM_HOME=1/);
    expect(toolScopeWarning('claude-agent-acp', { isolatedHarnessHome: true })).toBeTruthy();
    expect(toolScopeWarning('buzz-agent', { isolatedHarnessHome: false })).toBeUndefined();
  });

  it('names the remedy for a codex Room still reading the operator harness home', () => {
    const warning = toolScopeWarning('codex-acp', { isolatedHarnessHome: false });
    expect(warning).toMatch(/BUZZY_BODY_ROOM_HOME=1/);
    expect(warning).toMatch(/CODEX_HOME/);
  });

  it('still warns about the account-bound surface an isolated codex home cannot close', () => {
    const warning = toolScopeWarning('codex-acp', { isolatedHarnessHome: true });
    expect(warning).toMatch(/codex_apps/);
    expect(warning).not.toMatch(/BUZZY_BODY_ROOM_HOME=1/);
  });

  it('warns for a harness the daemon cannot scope at all, and for an unverified one', () => {
    expect(toolScopeWarning('pi-acp', { isolatedHarnessHome: true })).toBeTruthy();
    expect(toolScopeWarning('some-new-agent', { isolatedHarnessHome: true })).toBeTruthy();
  });
});

describe('NO_PERSONAL_CONNECTORS_INSTRUCTION', () => {
  it('forbids claiming, offering, or authorizing a personal connector', () => {
    expect(NO_PERSONAL_CONNECTORS_INSTRUCTION).toMatch(/never claim/i);
    expect(NO_PERSONAL_CONNECTORS_INSTRUCTION).toMatch(/never offer to connect/i);
    expect(NO_PERSONAL_CONNECTORS_INSTRUCTION).toMatch(/connector settings/i);
  });
});

describe('every session/new the daemon sends', () => {
  it('carries the claude lockdown and the system prompt the adapter actually reads', async () => {
    const params = (await capturedSessionNew('claude-agent-acp.mjs')) as {
      mcpServers: Array<{ name: string }>;
      systemPrompt?: string;
      _meta?: {
        claudeCode?: {
          options?: {
            strictMcpConfig?: boolean;
            settingSources?: string[];
            settings?: string;
          };
        };
        systemPrompt?: { append?: string };
      };
    };
    expect(params.mcpServers.map((server) => server.name)).toEqual(['buzz-readonly-mcp']);
    expect(params._meta?.claudeCode?.options?.strictMcpConfig).toBeUndefined();
    expect(params._meta?.claudeCode?.options?.settingSources).toEqual(['user']);
    expect(JSON.parse(params._meta?.claudeCode?.options?.settings ?? '{}')).toEqual(
      CLAUDE_TOOL_SCOPE_SETTINGS,
    );
    // claude-agent-acp reads only `_meta.systemPrompt`; `{ append }` keeps its
    // own claude_code preset underneath ours.
    expect(params._meta?.systemPrompt?.append).toBe('Beeline room boundary.');
    expect(params.systemPrompt).toBe('Beeline room boundary.');
  });

  it('still locks down a harness the OS sandbox spawns as an argument to bwrap', async () => {
    // Under bubblewrap the spawn command is `bwrap` and the harness is only an
    // argument to it. Matching on the command instead of the label would make
    // the connector lockdown silently vanish on every host with bwrap installed.
    const { binary, capture } = await fakeAgentNamed('bwrap.mjs');
    const client = new AcpClient({
      agentCommand: binary,
      agentLabel: '/usr/local/bin/claude-agent-acp',
      agentEnv: { SCOPE_CAPTURE: capture },
    });
    await client.start();
    try {
      await client.sessionNew({ cwd: tmpdir(), systemPrompt: 'Beeline room boundary.' });
    } finally {
      await client.stop();
    }
    const params = JSON.parse(await readFile(capture, 'utf8')) as {
      _meta?: {
        claudeCode?: {
          options?: { strictMcpConfig?: boolean; settingSources?: string[] };
        };
        systemPrompt?: { append?: string };
      };
    };
    expect(params._meta?.claudeCode?.options?.strictMcpConfig).toBeUndefined();
    expect(params._meta?.claudeCode?.options?.settingSources).toEqual(['user']);
    expect(params._meta?.systemPrompt?.append).toBe('Beeline room boundary.');
  });

  it('sends no harness-specific lockdown to a harness that has none', async () => {
    const params = (await capturedSessionNew('buzz-agent.mjs')) as {
      systemPrompt?: string;
      _meta?: unknown;
    };
    expect(params._meta).toBeUndefined();
    expect(params.systemPrompt).toBe('Beeline room boundary.');
  });
});

describe('the system prompt Beeline builds', () => {
  // A source assertion, in the same spirit as `pair-cli.test.ts`'s spinner rule:
  // body.test.ts drives Rooms with a `/nonexistent` binary, so no real
  // `session/new` params exist there to read the prompt back out of.
  const bodySource = readFileSync(new URL('./body.ts', import.meta.url), 'utf8');

  it('states the no-personal-connectors rule on BOTH the Room and the corner surface', () => {
    // 3 = the import plus the two prompt builders below.
    expect(bodySource.split('NO_PERSONAL_CONNECTORS_INSTRUCTION,').length - 1).toBe(3);
    expect(bodySource).toMatch(/read-only conversation channel\.',\s*\n\s*NO_PERSONAL_CONNECTORS_INSTRUCTION,/);
    expect(bodySource).toMatch(/coding agent in an edit session\.',\s*\n\s*NO_PERSONAL_CONNECTORS_INSTRUCTION,/);
  });

  it('warns the operator whenever a Room is provisioned onto an unscopeable harness', () => {
    expect(bodySource).toMatch(/toolScopeWarning\(this\.config\.agentCommand \?\? this\.config\.agentBinary, \{/);
    expect(bodySource).toMatch(/isolatedHarnessHome: Boolean\(this\.config\.agentHomeRoot\)/);
  });
});
