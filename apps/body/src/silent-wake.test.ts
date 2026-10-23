import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { CommandExecutionContext } from './server-command-intake.js';
import { callAgentTool } from './read-only-mcp.js';
import { sessionToolScopeMeta } from './harness-tool-scope.js';

let root: string;
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (root) await rm(root, { recursive: true, force: true }); });
it('rechecks eligibility when a retained session moves from report to human input, and posts nothing', async () => {
  root = await mkdtemp(join(tmpdir(), 'silent-wake-'));
  const context = new CommandExecutionContext(root);
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context.path);
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  vi.stubEnv('BEELINE_EXPLICIT_SILENT_RECEIPT', '1');
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal('fetch', fetch);
  const command = { roomId: 'room', turnRequestId: 'turn', rootCommandId: 'root', reason: 'report' } as AgentCommand;
  await context.enter(command);
  context.notePromptSections(['turn.task']);
  expect(JSON.parse(await readFile(context.path, 'utf8')).commandReason).toBe('report');
  for (const reason of ['report', 'order', 'watched_corner', 'schedule', 'subscribed_event', 'system']) {
    await context.enter({ ...command, reason });
    expect(JSON.parse(await callAgentTool('no_reply_needed', {}, 'silent-1'))).toEqual({ acknowledged: true });
    await expect(callAgentTool('no_reply_needed', {}, 'silent-again')).rejects.toThrow('turn has ended');
    await expect(callAgentTool('read', { facet: 'messages', address: 'room' }, 'read-after')).rejects.toThrow('turn has ended');
  }
  for (const reason of ['human_tag', 'direct_message', 'corner_brief_revision', 'unknown']) {
    await context.enter({ ...command, reason });
    await expect(callAgentTool('no_reply_needed', {}, 'silent-2')).rejects.toThrow('requires a nonhuman');
  }
  await context.leave();
  await expect(callAgentTool('no_reply_needed', {}, 'silent-3')).rejects.toThrow('no active server command');
  // R1: record silence immediately, leaving the terminal receipt to the helper
  // after it drains output. Rejected wakes and calls after silence write nothing.
  expect(fetch).toHaveBeenCalledTimes(6);
  for (const [url, request] of fetch.mock.calls) {
    expect(url).toEqual(new URL('http://localhost/v1/daemon/operations/markAgentTurnSilent'));
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({
      roomId: 'room', requestId: 'turn', taskId: 'root', generationId: context.generationId,
    });
  }
});
it('declares the exact Claude terminal tool in every new session, retaining existing names and isolated settings', () => {
  const meta = sessionToolScopeMeta('claude-agent-acp', 'other,other') as { claudeCode: { options: { env: Record<string, string>; settings: unknown } } };
  expect(meta.claudeCode.options.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS).toBe('other,mcp__beeline-agent__no_reply_needed');
  expect(meta.claudeCode.options.env.CLAUDE_CODE_SILENT_TURN_REMINDER).toBe('0');
  expect(meta.claudeCode.options.settings).toHaveProperty('disableClaudeAiConnectors', true);
  expect(sessionToolScopeMeta('codex-acp')?.claudeCode).toBeUndefined();
});
