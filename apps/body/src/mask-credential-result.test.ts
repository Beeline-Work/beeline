import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient, agentTurnSteps, toolCallEntries, type ToolCallEntry } from './acp.js';
import { maskCredentialResult } from './mask-credential-result.js';
import { cornerToolActivity, outputExcerpt } from './monolith-corner-turn.js';
import { roomReplySteps } from './room-turn-steps.js';
import { toolCallFailureLine } from './tool-call-failure.js';
import { TurnTrace, TurnTraceFile } from './turn-trace.js';
import { FreeAgentContinuation } from './free-agent-continuation.js';
import { distillTurnFailureReason, turnErrorDetail } from './turn-failure-reason.js';
import { sanitizeTurnReplay } from '@beeline/api-contract/daemon';

const result = 'an arbitrary result with no recognizable credential format';
const ordinary = 'token=ordinary password=value FOO=bar Bearer abc ghp_abcdefghijklmnop';

it.each<ToolCallEntry>([
  { name: 'fetch_credential' },
  { title: 'mcp__trusty-squire__fetch_credential' },
  { title: 'squire.fetch_credential' },
  { title: 'tools/call', rawInput: { name: 'fetch_credential' } },
  { title: 'app_tool', rawInput: { tool: 'fetch_credential' } },
  { rawInput: JSON.stringify({ arguments: { tool_input: { name: 'fetch_credential' } } }) },
])('masks only the result identified by tool metadata: %j', identity => {
  const call = { ...identity, content: result, rawOutput: { output: result }, locations: [{ path: result }] };
  expect(maskCredentialResult(call)).toMatchObject({ content: '[REDACTED]', rawOutput: '[REDACTED]', locations: undefined });
  expect(call.content).toBe(result);
});

it('leaves ordinary calls untouched even when their output names fetch_credential', () => {
  const call = { title: `echo ${ordinary}`, rawInput: { command: ordinary }, content: `fetch_credential ${ordinary}` };
  expect(maskCredentialResult(call)).toBe(call);
  expect(outputExcerpt(call.content)).toBe(call.content);
  expect(toolCallFailureLine({ ...call, status: 'failed' })).toBe(`${call.title} refused: ${call.content}`);
  expect(distillTurnFailureReason(ordinary).text).toBe(ordinary);
  expect(turnErrorDetail(ordinary)).toBe(ordinary);
});

it.each(['content', 'rawOutput'] as const)('masks %s in transcripts, step details, logs, traces, reports and saved checkpoints', async field => {
  const call: ToolCallEntry = { id: 'fetch', title: 'squire.fetch_credential', status: 'failed', [field]: { text: result } };
  const updates = [
    { sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: call.id, title: call.title } },
    { sessionId: 'session', update: { sessionUpdate: 'tool_result', toolCallId: call.id, status: call.status, [field]: call[field] } },
  ];
  const transcript = toolCallEntries(updates);
  expect(transcript[0]?.[field]).toBe('[REDACTED]');
  const steps = agentTurnSteps(updates);
  const room = roomReplySteps(steps);
  const corner = await cornerToolActivity(call, '/unused');
  expect(corner.output).toBe('[REDACTED]');
  const log = toolCallFailureLine(call);
  expect(log).toContain('[REDACTED]');
  const trace = new TurnTrace({ surface: 'room', agentId: 'agent', roomId: 'room', requestId: 'request' });
  trace.toolCalls([call]);
  expect(trace.replay()?.attempts[0]?.tools[0]?.error).toBe('[REDACTED]');
  const directory = await mkdtemp(join(tmpdir(), 'credential-result-'));
  try {
    const logs: string[] = [];
    const sink = new TurnTraceFile(directory, { log: line => logs.push(line) });
    const snapshot = trace.snapshot('failed');
    await sink.write(snapshot);
    const checkpointPath = join(directory, 'checkpoint.json');
    const continuation = new FreeAgentContinuation(checkpointPath);
    await continuation.begin('work');
    await continuation.stopped({ stopReason: 'free-agent-time-limit', agentText: '', updates, toolCalls: [call] });
    expect(continuation.context?.tools[0]).toContain('[REDACTED]');
    for (const surface of [transcript, steps, room, corner, log, snapshot, trace.replay(), sanitizeTurnReplay(trace.replay()),
      logs, await readFile(sink.path(), 'utf8'), await readFile(checkpointPath, 'utf8')]) {
      expect(JSON.stringify(surface)).not.toContain(result);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps ordinary tool arguments and output in step details and checkpoints', async () => {
  const call = { title: 'shell', status: 'failed', rawInput: { command: ordinary }, content: ordinary };
  expect(await cornerToolActivity(call, '/unused')).toMatchObject({ command: ordinary, output: ordinary });
  const checkpoint = new FreeAgentContinuation();
  await checkpoint.begin('work');
  await checkpoint.stopped({ stopReason: 'free-agent-time-limit', agentText: '', updates: [], toolCalls: [call] });
  expect(checkpoint.context?.tools[0]).toContain(ordinary);
  const trace = new TurnTrace({ surface: 'room', agentId: 'agent', roomId: 'room', requestId: 'request' });
  trace.toolCalls([call]);
  expect(trace.replay()?.attempts[0]?.tools[0]?.error).toBe(ordinary);
});

it('masks the recorded ACP updates and streaming callbacks while leaving the harness result alone', async () => {
  const client = new AcpClient({ agentCommand: 'fixture', agentEnv: {} });
  const raw = { sessionId: 'session', update: { sessionUpdate: 'tool_result', toolCallId: 'fetch', content: result, rawOutput: result } };
  vi.spyOn(client, 'request').mockImplementation(async () => {
    client.emit('session/update', { sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: 'fetch', name: 'fetch_credential' } });
    client.emit('session/update', raw);
    return { stopReason: 'end_turn' };
  });
  const streamed: unknown[] = [];
  const completed = await client.sessionPrompt('session', 'work', undefined, undefined, calls => streamed.push(calls));
  expect(completed.updates[1]?.update.content).toBe('[REDACTED]');
  expect(JSON.stringify([completed, streamed])).not.toContain(result);
  expect(raw.update.content).toBe(result);
});

it('masks credential-fetch errors again at the report storage boundary', () => {
  const replay = sanitizeTurnReplay({ totalMs: 0, attempts: [{ tools: [
    { name: 'squire.fetch_credential', outcome: 'error', error: result },
    { name: 'shell', outcome: 'error', error: ordinary },
  ] }] });
  expect(replay?.attempts[0]?.tools.map(tool => tool.error)).toEqual(['[REDACTED]', ordinary]);
});

it('does not carry credential identity into the next anonymous tool call', async () => {
  const client = new AcpClient({ agentCommand: 'fixture', agentEnv: {} });
  vi.spyOn(client, 'request').mockImplementation(async () => {
    for (const update of [
      { sessionUpdate: 'tool_call', name: 'fetch_credential' },
      { sessionUpdate: 'tool_result', content: result },
      { sessionUpdate: 'tool_call', title: 'shell', content: ordinary },
      { sessionUpdate: 'tool_result', content: ordinary },
    ]) client.emit('session/update', { sessionId: 'session', update });
    return { stopReason: 'end_turn' };
  });
  const completed = await client.sessionPrompt('session', 'work');
  expect(completed.toolCalls.map(call => call.content)).toEqual(['[REDACTED]', ordinary]);
  expect(completed.updates[2]?.update.content).toBe(ordinary);
});

it('retains a credential-fetch refusal when masking its MCP error payload', () => {
  const call = { name: 'fetch_credential', status: 'completed', rawOutput: { isError: true, content: result } };
  expect(toolCallFailureLine(call)).toBe('tool refused: [REDACTED]');
});

it('masks a sparse background completion before handing it to its recorder', () => {
  const client = new AcpClient({ agentCommand: 'fixture', agentEnv: {} });
  const complete = vi.fn();
  client.detachedTools.set('session\0fetch', { call: { id: 'fetch', name: 'fetch_credential' }, complete });
  client.handleMessage({ method: 'session/update', params: { sessionId: 'session', update: {
    sessionUpdate: 'tool_result', toolCallId: 'fetch', rawOutput: result,
  } } });
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ rawOutput: '[REDACTED]' }));
  expect(JSON.stringify(complete.mock.calls)).not.toContain(result);
});
