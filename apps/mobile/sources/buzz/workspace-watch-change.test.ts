import { describe, expect, it } from 'vitest';
import { workspaceWatchChanges } from './workspace-watch-change';
const scope = { workspaceId: 'w', principal: 'ada', memberIds: new Set(['ada', 'agent-a']) };
const changes = (live: unknown) => workspaceWatchChanges({ monolithLive: live } as never, scope);

describe('legacy Workspace roster source relevance (F03)', () => {
  it('ignores 1,000 draft, turn and presence frames without asking any reader to refresh', () => {
    let reads = 0;
    for (let i = 0; i < 1000; i++) for (const type of ['draft', 'draft-append', 'thought', 'thought-append', 'presence', 'turn-delta', 'room-commands'])
      if (changes({ type, roomId: 'room', agentId: 'agent-a', turnId: 'turn', text: 'text' })) reads++;
    expect(reads).toBe(0);
  });
  it.each(['postgres:live_outputs', 'postgres:agent_turns', 'postgres:agent_commands', 'postgres:messages', 'message', 'turn', 'activity'])
    ('ignores non-roster durable hint %s', reason => {
      expect(changes({ type: 'invalidate', roomId: 'room', reason })).toBe(false);
    });
  it('accepts membership/grant/profile changes while rejecting unrelated owners and workspaces', () => {
    expect(changes({ type: 'invalidate', roomId: 'room', reason: 'postgres:memberships' })).toBe(true);
    expect(changes({ type: 'invalidate', roomId: 'room', reason: 'postgres:agent_grants' })).toBe(true);
    expect(changes({ type: 'resource-change', roomId: '', resource: 'agent', resourceId: 'agent-a' })).toBe(true);
    expect(changes({ type: 'resource-change', roomId: '', resource: 'agent', resourceId: 'other-agent' })).toBe(false);
    expect(changes({ type: 'resource-change', roomId: '', resource: 'workbench' })).toBe(false);
    expect(changes({ type: 'invalidate', roomId: 'room', workspaceId: 'other', reason: 'postgres:memberships' })).toBe(false);
    expect(changes({ type: 'person-changed', roomId: '', person: { pubkey: 'ada' } })).toBe(true);
    expect(changes({ type: 'person-changed', roomId: '', person: { pubkey: 'someone-else' } })).toBe(false);
  });
});
