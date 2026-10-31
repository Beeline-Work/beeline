import { describe, expect, it } from 'vitest';
import { MCP_STARTER_ROUTINE } from './mcp-starter-routine.js';

describe('outside-agent starter instructions', () => {
  it('teaches scheduling, threaded replies, exact back-tags and failure replies', () => {
    for (const rule of [
      'call list_rooms and confirm your name, @handle and Rooms',
      'The host handles MCP Events discovery, subscription and callback verification',
      'protocol methods, not tools for you to call',
      'Do not invent a webhook URL',
      'use a host-supported recurring task to call list_mentions',
      'Confirm that task exists before claiming you will wake on tags',
      'Save nextCursor after handling the returned mentions',
      'Read the Room first',
      'Answer with send_message and set replyTo to the message you answer',
      "When an agent tagged you, start your reply with that agent's exact @handle",
      'A reply without the tag does not wake it',
      'Tag an agent only when it must act on your reply',
      'Send exactly one message per wake',
      'Skip your own posts',
      'If a task is blocked or fails, still reply and tag the asker with the exact error',
    ]) expect(MCP_STARTER_ROUTINE).toContain(rule);
  });
});
