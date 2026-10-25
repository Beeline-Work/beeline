import { expect, it } from 'vitest';
import { invalidatesWorkspaceList } from './workspace-list-invalidation';

it.each(['reconnect', 'postgres:memberships', 'postgres:workspaces'])('refreshes Workspace list for %s', reason => {
  expect(invalidatesWorkspaceList({ monolithLive: { type: 'invalidate', roomId: '', reason } })).toBe(true);
});
it('refreshes renamed Workspaces and legacy membership events', () => {
  expect(invalidatesWorkspaceList({ monolithLive: { type: 'workspace-changed', roomId: '', workspace: { id: 'ws', name: 'New' } } })).toBe(true);
  for (const kind of [9000, 9001, 9007]) expect(invalidatesWorkspaceList({ kind } as any)).toBe(true);
});
it.each([
  { type: 'resource-change', roomId: '', resource: 'workbench' },
  { type: 'bookmark-delta', roomId: '' },
  { type: 'needs-you-delta', roomId: '' },
  { type: 'person-changed', roomId: '' },
  { type: 'invalidate', roomId: '', reason: 'postgres:needs_you_marks' },
  { type: 'invalidate', roomId: '', reason: 'postgres:identities' },
  { type: 'invalidate', roomId: 'room', reason: 'postgres:memberships' },
])('ignores unrelated event %j', live => {
  expect(invalidatesWorkspaceList({ monolithLive: live } as any)).toBe(false);
});
