import { describe, expect, it } from 'vitest';
import { isFailedToolCall, toolCallFailureLine } from './tool-call-failure.js';

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

  it('scrubs a credential out of the reason', () => {
    const line = toolCallFailureLine({
      id: 'call-3',
      title: 'run_granted_command',
      status: 'failed',
      content: [{ type: 'text', text: 'denied: token=ghp_abcdefghijklmnop failed' }],
    });
    expect(line).not.toContain('ghp_abcdefghijklmnop');
    expect(line).toContain('[REDACTED]');
  });

  it('says nothing about a call that did not fail', () => {
    expect(toolCallFailureLine({ id: 'call-4', title: 'open_corner', status: 'completed' })).toBe(
      undefined,
    );
    expect(isFailedToolCall({ id: 'call-4', status: 'completed' })).toBe(false);
    expect(isFailedToolCall({ id: 'call-5', status: 'failed' })).toBe(true);
  });
});
