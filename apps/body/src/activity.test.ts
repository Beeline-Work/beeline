import { describe, expect, it } from 'vitest';
import { compactActivityUpdate } from './activity.js';

describe('compactActivityUpdate', () => {
  it('drops reasoning and startup-only telemetry from the Room projection', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'private chain of thought' },
      }),
    ).toBeUndefined();
    expect(
      compactActivityUpdate({ sessionUpdate: 'session_info_update', model: 'codex' }),
    ).toBeUndefined();
  });

  it('projects commands, output, edited files, and plans without sensitive input', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Apply patch',
        kind: 'edit',
        status: 'completed',
        rawInput: {
          command: 'npm test',
          token: 'do-not-project-me',
          changes: [{ path: 'apps/mobile/chat.tsx', patch: 'diff --git a/chat b/chat' }],
          plan: [
            { step: 'Implement projection', status: 'completed' },
            { step: 'Run tests', status: 'in_progress' },
          ],
        },
        rawOutput: '12 tests passed',
      }),
    ).toEqual({
      sessionUpdate: 'tool_activity',
      toolCallId: 'call-1',
      title: 'Apply patch',
      kind: 'edit',
      status: 'completed',
      command: 'npm test',
      input: expect.stringContaining('"token": "[redacted]"'),
      output: '12 tests passed',
      files: [
        {
          path: 'apps/mobile/chat.tsx',
          diff: 'diff --git a/chat b/chat',
        },
      ],
      plan: {
        items: [
          { step: 'Implement projection', status: 'completed' },
          { step: 'Run tests', status: 'in_progress' },
        ],
      },
    });
  });

  it('keeps concise natural-language progress while stripping a leading harness notice', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'status_update',
        content:
          'Warning: tool descriptions exceed the context budget limit\n\nFound the rendering boundary.',
      }),
    ).toEqual({
      sessionUpdate: 'progress_update',
      text: 'Found the rendering boundary.',
    });
  });

  it('extracts real per-file patches from apply_patch input', () => {
    expect(
      compactActivityUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'patch-1',
        title: 'apply_patch',
        kind: 'edit',
        rawInput:
          '*** Begin Patch\n*** Update File: apps/mobile/chat.tsx\n@@\n-old\n+new\n*** End Patch',
      }),
    ).toMatchObject({
      files: [
        {
          path: 'apps/mobile/chat.tsx',
          status: 'modified',
          diff: expect.stringContaining('@@\n-old\n+new'),
        },
      ],
    });
  });
});
