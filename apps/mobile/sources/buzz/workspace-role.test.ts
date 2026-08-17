import { describe, expect, it } from 'vitest';

import { isWorkspaceManagerRole } from './workspace-role';

describe('isWorkspaceManagerRole', () => {
  it('grants management to owners and admins', () => {
    expect(isWorkspaceManagerRole('owner')).toBe(true);
    expect(isWorkspaceManagerRole('admin')).toBe(true);
  });

  it('withholds management from members and unresolved roles', () => {
    expect(isWorkspaceManagerRole('member')).toBe(false);
    expect(isWorkspaceManagerRole(undefined)).toBe(false);
    expect(isWorkspaceManagerRole(null)).toBe(false);
  });
});
