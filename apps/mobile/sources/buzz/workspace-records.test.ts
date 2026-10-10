import { expect, it, vi } from 'vitest';
import type { WorkspaceView } from '@beeline/buzz-client';
vi.mock('./workspace-surface', () => ({ workspaceAgentFromDetail: vi.fn() }));

import { resetClientState } from '@/sync/client-reset';
import {
  currentWorkspaceRecord,
  currentWorkspaceRows,
  recordWorkspaceRows,
  workspaceRecordScope,
} from './workspace-records';

type MemberRecord = WorkspaceView['members'][number];

it('drops every record on an identity or relay change', () => {
  const scope = workspaceRecordScope('https://relay.example', 'viewer', 'workspace-1');
  const row = { identity: { pubkey: 'agent-1', kind: 'agent', name: 'Renamed' }, role: 'member' } as unknown as MemberRecord;
  const stale = { ...row, identity: { ...row.identity, name: 'Old' } } as MemberRecord;
  recordWorkspaceRows(scope, [row]);
  expect(currentWorkspaceRows(scope, [stale])[0]?.identity.name).toBe('Renamed');
  resetClientState();
  expect(currentWorkspaceRecord(scope, 'agent-1')).toBeUndefined();
  expect(currentWorkspaceRows(scope, [stale])[0]?.identity.name).toBe('Old');
});
