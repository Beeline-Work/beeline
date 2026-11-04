import { describe, expect, it } from 'vitest';
import { changesDaemonInbox } from './daemon-inbox-cause.js';
describe('F13 targeted helper context', () => {
  it.each(['agent_turns','agent_activity','agent_usage','agents','corner_follows','agent_grants','agent_subscriptions','room_read_marks','corner_owed'])(
    '%s cannot turn another agent transition into an inbox read', table => {
      expect(changesDaemonInbox({ type: 'invalidate', roomId: 'room', reason: `postgres:${table}`, messageId: 'unrelated' })).toBe(false);
    });
  it('requires an exact changed message for the existing durable/legacy message path', () => {
    expect(changesDaemonInbox({ type: 'invalidate', roomId: 'room', reason: 'postgres:messages', messageId: 'changed' })).toBe(true);
    expect(changesDaemonInbox({ type: 'invalidate', roomId: 'room', reason: 'phone-write', messageId: 'changed' })).toBe(true);
    expect(changesDaemonInbox({ type: 'invalidate', roomId: 'room', reason: 'phone-write' })).toBe(false);
  });
});
