import { describe, expect, it } from 'vitest';
import { inviteSummary, inviterRoleLabel } from './invite-summary';

describe('invite summary', () => {
  it('names the inviter and the Workspace size', () => {
    expect(
      inviteSummary({
        name: 'Northstar Lab',
        expiresAt: 1,
        inviter: { name: 'Mara' },
        memberCount: 8,
        agentCount: 4,
      }),
    ).toBe('Mara invited you to a workspace with 8 people and 4 agents.');
    expect(
      inviteSummary({
        name: 'Solo',
        expiresAt: 1,
        inviter: { name: 'Jo' },
        memberCount: 1,
        agentCount: 0,
      }),
    ).toBe('Jo invited you to a workspace with 1 person.');
  });

  it('stays a sentence against an older server that sends neither', () => {
    expect(inviteSummary({ name: 'Old', expiresAt: 1 })).toBe(
      'Someone invited you to a workspace.',
    );
  });

  it('labels the inviter by role', () => {
    expect(inviterRoleLabel('owner')).toBe('Workspace owner');
    expect(inviterRoleLabel('admin')).toBe('Workspace admin');
    expect(inviterRoleLabel(undefined)).toBe('Member');
  });
});
