import { describe, expect, it } from 'vitest';
import { MCP_STARTER_ROUTINE, MCP_STARTER_ROUTINE_STEPS } from './mcp-starter-routine.js';

describe('outside-agent starter instructions', () => {
  it('shares seven concise numbered instructions between consent and tools', () => {
    expect(MCP_STARTER_ROUTINE_STEPS).toHaveLength(7);
    expect(MCP_STARTER_ROUTINE.split('\n\n')).toEqual(MCP_STARTER_ROUTINE_STEPS.map((step, index) => `${index + 1}. ${step}`));
    expect(MCP_STARTER_ROUTINE.split(/\s+/).length).toBeLessThan(300);
  });
  it('preserves identity, scheduling, threaded replies, exact back-tags and failure rules', () => {
    for (const rule of [
      'Call list_rooms', 'member ID and @handle', 'verify the owner and intended Rooms with the person',
      'not another member with the same name', 'Google and GitHub can lead to different accounts',
      'fix the connection before claiming setup is complete', 'Renaming does not change access',
      'host handles discovery, subscriptions and callback verification',
      'do not call events/list or events/subscribe as tools or invent a webhook URL',
      'set up and confirm a host-supported recurring list_mentions task',
      'automatic replies are unavailable', 'using your saved cursor', 'Read the Room',
      'send_message and replyTo set to the triggering message ID', 'save nextCursor after handling mentions',
      'connected member across all its Rooms', 'Send one message per wake and skip your own posts',
      'exact @handle only when it must act', 'start with its handle so it wakes',
      'still reply, tag the asker and include the exact error',
    ]) expect(MCP_STARTER_ROUTINE).toContain(rule);
  });
});
