import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { toolValidationSchema, type ToolDefinition } from './minimal-tool-surface.js';
import { assembleSessionPrompt, PROMPT_SURFACES } from './prompt-assembly.js';

const harnesses = ['claude-agent-acp', 'claude-code-acp', 'codex-acp', 'pi-acp', 'grok', 'buzz-agent', 'cursor-acp-bridge'];
const missingOnClaude = ['request_grant', 'connect', 'app_tool', 'wake', 'remember', 'revise_corner'];
const rootCombinators = ['anyOf', 'oneOf', 'allOf'];
const invalidInputs = [
  ['request_grant', { action: 'request', kind: 'command' }],
  ['connect', { mode: 'ensure', service: 'Linear' }],
  ['app_tool', { app: 'beeline:workflow', args: {} }],
  ['wake', { action: 'create', trigger: 'schedule', title: 'Reminder', prompt: 'x'.repeat(2001) }],
  ['remember', { kind: 'fact', action: 'save', body: 'No sources' }],
  ['revise_corner', { action: 'brief', address: 'child', brief: { spec: 'Change' } }],
] as const;

describe('Beeline tool surface across harnesses', () => {
  it.each(harnesses)('%s receives every tool named by its prompt', agentCommand => {
    for (const surface of PROMPT_SURFACES) {
      const corner = surface.endsWith('corner');
      const tools = agentToolsFor(true, surface === 'dm', corner, surface === 'code-corner', true, true, true);
      // Claude Code can drop a tool whose root schema has a combinator. Pi
      // accepts the same schema: this was Ruby's exact 28 -> 22 discrepancy.
      const accepted = tools.filter(tool => rootCombinators.every(key => !(key in tool.inputSchema)));
      expect(accepted.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
      expect(accepted).toHaveLength(28);
      expect(accepted.map(tool => tool.name)).toEqual(expect.arrayContaining(missingOnClaude));
      const prompt = assembleSessionPrompt({ surface, agentName: 'Bee', agentCommand }).systemPrompt;
      const inventory = prompt.match(/^Beeline tools: (.+)\.$/m)?.[1]?.replaceAll('`', '').split(', ');
      const core = agentToolsFor(true, surface === 'dm', corner, surface === 'code-corner', false, true, true);
      expect(inventory).toEqual(core.map(tool => tool.name));
      for (const name of inventory ?? []) expect(accepted.map(tool => tool.name)).toContain(name);
    }
  });

  it.each(invalidInputs)('still rejects invalid %s arguments before any server call', async (name, args) => {
    await expect(callAgentTool(name, args, 'invalid-combination')).rejects.toThrow(/invalid arguments/);
  });

  it('retains every field, nested schema and branch rule for Claude without changing the canonical contract', () => {
    for (const tool of agentToolsFor(true, false, false, false, true, true, true)) {
      const canonical = toolValidationSchema(tool.name);
      if (!canonical) continue;
      expect(tool.inputSchema.properties).toEqual(canonical.properties);
      expect(tool.inputSchema.required).toEqual(canonical.required);
      const rules = Object.fromEntries(rootCombinators.filter(key => key in canonical).map(key => [key, canonical[key]]));
      if (Object.keys(rules).length) expect(tool.description).toContain(JSON.stringify(rules));
    }
    const valid = { kind: 'procedure', action: 'save', slug: 'widget', description: 'Build widgets', markdown: 'Steps' };
    expect(Check(toolValidationSchema('remember')!, valid)).toBe(true);
    expect(Check(toolValidationSchema('remember')!, { ...valid, action: 'update' })).toBe(false);
  });

  it('also preserves the fallback repository and scratch tools under Claude schema rules', () => {
    const tools = [...agentToolsFor(false, false), ...agentToolsFor(true, false, false, false, false, true, false)];
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['repository_io', 'scratch_io']));
    for (const tool of tools) {
      for (const key of rootCombinators) expect(tool.inputSchema).not.toHaveProperty(key);
    }
    expect(tools.find(tool => tool.name === 'scratch_io')!.inputSchema.properties).toMatchObject({ action: { enum: ['write', 'image'] } });
  });

  it('serves the same catalog over MCP stdio with Claude-compatible schemas', async () => {
    // Standalone MCP discovery only: no helper, harness, credentials or server.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BEELINE_')));
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))], {
      env: { ...env, BEELINE_MCP_SURFACE: 'agent', BEELINE_NATIVE_IO_PROVEN: '1', BEELINE_GRANT_RUNNER_URL: 'http://127.0.0.1:1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        ...invalidInputs.map(([name, args], index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: args } })),
      ];
      child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
      expect(await closed, stderr).toBe(0);
      const responses = stdout.trim().split('\n').map(line => JSON.parse(line)) as Array<{
        id: number; result: { tools: ToolDefinition[]; isError?: boolean; content?: Array<{ text: string }> };
      }>;
      const tools = responses.find(response => response.id === 1)!.result.tools;
      expect(tools).toEqual(agentToolsFor(true, false, false, false, true, true, true));
      expect(tools.filter(tool => rootCombinators.every(key => !(key in tool.inputSchema)))).toHaveLength(28);
      for (let index = 0; index < invalidInputs.length; index++) {
        const response = responses.find(response => response.id === index + 2)!;
        expect(response.result.isError).toBe(true);
        expect(response.result.content?.[0]?.text).toMatch(/invalid arguments/);
      }
    } finally {
      child.kill();
    }
  });
});
