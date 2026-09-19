import { describe, expect, it } from 'vitest';

import { isWorkspaceManagerRole, isWorkspaceMasterRole } from './workspace-role';

describe('isWorkspaceManagerRole', () => {
  it('grants management to masters and admins', () => {
    expect(isWorkspaceManagerRole('master')).toBe(true);
    expect(isWorkspaceManagerRole('admin')).toBe(true);
  });

  it('withholds management from members and unresolved roles', () => {
    expect(isWorkspaceManagerRole('member')).toBe(false);
    expect(isWorkspaceManagerRole(undefined)).toBe(false);
    expect(isWorkspaceManagerRole(null)).toBe(false);
  });
});

describe('isWorkspaceMasterRole', () => {
  it('is true only for master', () => {
    expect(isWorkspaceMasterRole('master')).toBe(true);
    expect(isWorkspaceMasterRole('admin')).toBe(false);
    expect(isWorkspaceMasterRole('member')).toBe(false);
  });
});
