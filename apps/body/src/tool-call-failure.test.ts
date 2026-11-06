import { describe, expect, it } from 'vitest';
import { isFailedToolCall, isPrivateWorkToolCall, toolCallFailureLine } from './tool-call-failure.js';

describe('toolCallFailureLine', () => {
  it('says out loud what a refused open_corner was told', () => {
    // The exact shape grok reports an MCP refusal in: the sentence is in the
    // call's content, and the journal used to print none of it (C90).
    expect(
      toolCallFailureLine({
        id: 'call-1',
        title: 'beeline-agent__open_corner',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'the objective is 61 words; the limit is 24' },
          },
        ],
      }),
    ).toBe('beeline-agent__open_corner refused: the objective is 61 words; the limit is 24');
  });

  it("reads grok's reason, which lives only in rawOutput", () => {
    // Captured live from `grok agent stdio`: the failed update carries no
    // content at all, and the sentence is under rawOutput.output.Error.
    expect(
      toolCallFailureLine({
        id: 'call-grok',
        title: 'beeline-agent__open_corner',
        status: 'failed',
        rawOutput: {
          type: 'MCP',
          tool_name: 'open_corner',
          server_name: 'beeline-agent',
          output: { Error: 'the objective is 43 words; the limit is 24' },
          is_error: true,
        },
      }),
    ).toBe('beeline-agent__open_corner refused: the objective is 43 words; the limit is 24');
  });

  it('still names the call when the harness gave no reason', () => {
    expect(toolCallFailureLine({ id: 'call-2', title: 'open_corner', status: 'failed' })).toBe(
      'open_corner refused with no reason given',
    );
  });

  it('says nothing about a call that did not fail', () => {
    expect(toolCallFailureLine({ id: 'call-4', title: 'open_corner', status: 'completed' })).toBe(
      undefined,
    );
    expect(isFailedToolCall({ id: 'call-4', status: 'completed' })).toBe(false);
    expect(isFailedToolCall({ id: 'call-5', status: 'failed' })).toBe(true);
  });


});

it('recognizes compact checks reads across harness envelopes while retaining legacy activity', async () => {
  const { isPrChecksRead } = await import('./tool-call-failure.js');
  expect(isPrChecksRead({ title: 'beeline.pr_checks_status' })).toBe(true);
  for (const rawInput of [{ facet: 'checks' }, { server: 'beeline-agent', arguments: { facet: 'checks' } }, { tool_input: { facet: 'checks' } }, JSON.stringify({ facet: 'checks' })])
    expect(isPrChecksRead({ title: 'mcp__beeline_agent__read', rawInput })).toBe(true);
  expect(isPrChecksRead({ title: 'beeline.read', rawInput: { facet: 'messages' } })).toBe(false);
  expect(isPrChecksRead({ title: 'Read file', rawInput: { path: 'checks' } })).toBe(false);
});

it('counts only completed commander delivery as a private answer, excluding feedback variants', async () => {
  const { isPrivateWorkToolCall } = await import('./tool-call-failure.js');
  expect(isPrivateWorkToolCall({ title: 'beeline.report', status: 'completed' })).toBe(true);
  expect(isPrivateWorkToolCall({ title: 'beeline.report', status: 'completed', rawInput: { arguments: { kind: 'commander' } } })).toBe(true);
  for (const kind of ['feedback', 'fixed']) expect(isPrivateWorkToolCall({ title: 'beeline.report', status: 'completed', rawInput: { tool_input: { kind } } })).toBe(false);
  expect(isPrivateWorkToolCall({ title: 'beeline.report', status: 'in_progress' })).toBe(false);
});

// Adapter success cannot turn an MCP refusal into delivered assignment work.
it('does not accept a completed report whose MCP payload isError is true', () => {
  const call = { title: 'mcp__beeline-agent__report', status: 'completed', rawOutput: { isError: true } };
  expect(isPrivateWorkToolCall(call)).toBe(false);
});
