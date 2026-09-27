import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { readOnlyMcpServer, beelineAgentMcpServer } from './room-session.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { agentMemorySnapshot, prepareAgentMemory } from './agent-memory.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function call(env: Record<string, string>, name: string, args: Record<string, unknown>) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))],
    {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  try {
    const answer = new Promise<{ result?: { content: { text: string }[]; isError?: boolean } }>(
      (done, fail) => {
        const timer = setTimeout(() => fail(new Error('MCP timed out')), 20_000);
        createInterface({ input: child.stdout }).on('line', (line) => {
          const frame = JSON.parse(line);
          if (frame.id === 1) {
            clearTimeout(timer);
            done(frame);
          }
        });
      },
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`,
    );
    return (await answer).result!;
  } finally {
    child.kill();
  }
}

it('saves agent memory in a Room and recalls it in a later process, within only its approved root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-memory-'));
  roots.push(root);
  const agentA = resolve(root, 'agent-a', 'workspace-1');
  const agentB = resolve(root, 'agent-b', 'workspace-1');
  const skills = resolve(root, 'skills');
  await Promise.all([
    mkdir(agentA, { recursive: true }),
    mkdir(agentB, { recursive: true }),
    mkdir(skills),
  ]);
  await writeFile(resolve(skills, 'SKILL.md'), 'approved skill');
  await writeFile(resolve(agentB, 'MEMORY.md'), 'Other agent private memory');
  const turnContext = resolve(root, 'turn-context.json');
  await writeFile(
    turnContext,
    JSON.stringify({ roomId: 'room-1', requestId: 'request-1', generationId: 'generation-1' }),
  );
  const config = {
    agentBinary: 'agent',
    mcpBinary: 'unused',
    readonlyMcpCommand: process.execPath,
    agentEnv: {},
    workspaceRoot: root,
    autoApprovePermissions: false,
  };
  const api = new DaemonApiClient('http://127.0.0.1:1', 'token', 'agent-a');
  const agentWire = beelineAgentMcpServer(config, api, {
    roomId: 'room-1',
    workspaceId: 'workspace-1',
    agentMemoryDir: agentA,
  });
  const readWire = readOnlyMcpServer(config, root, agentA);
  const agentEnv = {
    ...Object.fromEntries(agentWire.env!.map(({ name, value }) => [name, value])),
    BEELINE_TURN_CONTEXT_FILE: turnContext,
  };
  const readEnv = Object.fromEntries(readWire.env!.map(({ name, value }) => [name, value]));
  const content = 'Delivery card: retain the release checklist for later turns.';

  const readOnlyWrite = await call(readEnv, 'write_memory', { content });
  expect(readOnlyWrite.isError).toBe(true);
  const withoutTurn = await call({ ...agentEnv, BEELINE_TURN_CONTEXT_FILE: '' }, 'write_memory', {
    content,
  });
  expect(withoutTurn.isError).toBe(true);
  const withoutRoot = await call(
    { ...agentEnv, BEELINE_READONLY_AGENT_MEMORY_ROOT: '' },
    'write_memory',
    { content },
  );
  expect(withoutRoot.isError).toBe(true);
  expect(withoutRoot.content[0].text).toBe('approved memory material is unavailable');
  const saved = await call(agentEnv, 'write_memory', { content });
  expect(saved.isError).not.toBe(true);
  const arbitraryPath = await call(agentEnv, 'write_memory', {
    content: 'escape',
    path: '../agent-b/workspace-1/MEMORY.md',
  });
  expect(arbitraryPath.isError).toBe(true);
  expect(await readFile(resolve(agentA, 'MEMORY.md'), 'utf8')).toBe(content);
  const recalled = await call(readEnv, 'read_agent_file', { area: 'memory', path: 'MEMORY.md' });
  expect(recalled.content[0].text).toContain(content);
  expect(await agentMemorySnapshot(agentA)).toContain(content);
  const other = await call(
    { ...readEnv, BEELINE_READONLY_AGENT_MEMORY_ROOT: agentB },
    'read_agent_file',
    { area: 'memory', path: 'MEMORY.md' },
  );
  expect(other.content[0].text).toContain('Other agent private memory');
  expect(other.content[0].text).not.toContain(content);
  const escape = await call(readEnv, 'read_agent_file', {
    area: 'memory',
    path: '../agent-b/workspace-1/MEMORY.md',
  });
  expect(escape.isError).toBe(true);
  await symlink(resolve(agentB, 'MEMORY.md'), resolve(agentA, 'elsewhere'));
  const linkedRead = await call(readEnv, 'read_agent_file', { area: 'memory', path: 'elsewhere' });
  expect(linkedRead.isError).toBe(true);
  await unlink(resolve(agentA, 'MEMORY.md'));
  await symlink(resolve(agentB, 'MEMORY.md'), resolve(agentA, 'MEMORY.md'));
  const linkedWrite = await call(agentEnv, 'write_memory', { content: 'attempted overwrite' });
  expect(linkedWrite.isError).toBe(true);
  await unlink(resolve(agentA, 'MEMORY.md'));
  await link(resolve(agentB, 'MEMORY.md'), resolve(agentA, 'MEMORY.md'));
  const hardlinkWrite = await call(agentEnv, 'write_memory', { content: 'attempted overwrite' });
  expect(hardlinkWrite.isError).toBe(true);
  const hardlinkRead = await call(readEnv, 'read_agent_file', {
    area: 'memory',
    path: 'MEMORY.md',
  });
  expect(hardlinkRead.isError).toBe(true);
  expect(await readFile(resolve(agentB, 'MEMORY.md'), 'utf8')).toBe('Other agent private memory');
  const oversized = await call(agentEnv, 'write_memory', { content: 'x'.repeat(16_001) });
  expect(oversized.isError).toBe(true);
  const skill = await call(
    { ...readEnv, BEELINE_READONLY_AGENT_SKILLS_ROOT: skills },
    'read_agent_file',
    { area: 'skills', path: 'SKILL.md' },
  );
  expect(skill.content[0].text).toContain('approved skill');
});

it('prepares one stable directory per Workspace and refuses a linked scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-memory-scope-'));
  roots.push(root);
  const memoryRoot = resolve(root, 'agent-memory');
  const first = await prepareAgentMemory(memoryRoot, 'workspace-1');
  expect(await prepareAgentMemory(memoryRoot, 'workspace-1')).toBe(first);
  expect(await prepareAgentMemory(memoryRoot, 'workspace-2')).not.toBe(first);
  await symlink(first!, resolve(memoryRoot, 'workspace-3'));
  await expect(prepareAgentMemory(memoryRoot, 'workspace-3')).rejects.toThrow('symbolic link');
  await expect(prepareAgentMemory(memoryRoot, '../other-agent')).rejects.toThrow(
    'invalid memory Workspace id',
  );
});
