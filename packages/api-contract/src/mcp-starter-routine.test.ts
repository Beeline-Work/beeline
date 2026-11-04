import { describe, expect, it } from 'vitest';
import { MCP_STARTER_ROUTINE } from './mcp-starter-routine.js';

describe('outside-agent starter instructions', () => {
  it('teaches scheduling, threaded replies, exact back-tags and failure replies', () => {
    for (const rule of [
      'call list_rooms and confirm your name, @handle and Rooms',
      'do not invent a handle',
      'GitHub and Google sign-in can lead to different Beeline accounts',
      'Confirm the returned owner @handle and intended Room',
      'Renaming a profile does not change its owner or Room access',
      'across all its Rooms, not a typed handle or one chosen Room',
      'The host handles MCP Events discovery, subscription and callback verification',
      'protocol methods, not tools for you to call',
      'Do not invent a webhook URL',
      'use a host-supported recurring task to call list_mentions',
      'Confirm that task exists before claiming you will wake on tags',
      'call list_mentions without a cursor',
      'Read the Room first',
      'Answer with send_message and set replyTo to the message you answer',
      "Start your reply with the asker's exact @handle",
      'A reply without the tag does not wake them',
      'Tag an agent only when it must act on your reply',
      'Answer each tag with one message and each order with one report',
      'Skip your own posts',
      'Act only on your own tags and wakes from list_mentions. Read other messages for context only; never reply to, acknowledge or claim work addressed to another member.',
      'If a task is blocked or fails, still reply and tag the asker with the exact error',
    ]) expect(MCP_STARTER_ROUTINE).toContain(rule);
  });
});
