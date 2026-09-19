import { describe, expect, it } from 'vitest';
import {
  conversationHeldByHumanAuthority,
  humanAuthorityContext,
  humanAuthorityTier,
  HUMAN_INSTRUCTION_AUTHORITY_RULE,
  resolveAgentOwnerIdentityId,
} from './human-authority.js';

const OWNER = 'aa'.repeat(32);
const ADMIN = 'bb'.repeat(32);
const MEMBER_A = 'cc'.repeat(32);
const MEMBER_B = 'dd'.repeat(32);
const AGENT = 'ee'.repeat(32);

const roster = {
  members: [
    {
      identityId: AGENT,
      kind: 'agent' as const,
      name: 'BBC',
      handle: 'bbc',
      role: 'member' as const,
      soul: {
        name: 'Bear',
        instructions: 'Steady.',
        avatarSeed: AGENT,
        authoredBy: OWNER,
        updatedAt: 1,
      },
    },
    {
      identityId: OWNER,
      kind: 'human' as const,
      name: 'Captain',
      handle: 'lunchboxfortwo',
      role: 'member' as const,
    },
    {
      identityId: ADMIN,
      kind: 'human' as const,
      name: 'Ada',
      handle: 'ada',
      role: 'admin' as const,
    },
    {
      identityId: MEMBER_A,
      kind: 'human' as const,
      name: 'bananaman',
      handle: 'bananaman614305',
      role: 'member' as const,
    },
    {
      identityId: MEMBER_B,
      kind: 'human' as const,
      name: 'Sam',
      handle: 'sam',
      role: 'member' as const,
    },
  ],
};

describe('human instruction authority tiers', () => {
  it('ranks the connected owner above a workspace admin even when the owner is an ordinary member', () => {
    expect(humanAuthorityTier(OWNER, 'member', OWNER)).toBe('owner');
    expect(humanAuthorityTier(ADMIN, 'admin', OWNER)).toBe('workspaceManager');
    expect(humanAuthorityTier(MEMBER_A, 'member', OWNER)).toBe('member');
    expect(humanAuthorityTier(OWNER, 'master', OWNER)).toBe('owner');
  });

  it('resolves owner identity from configuration first, then roster soul.authoredBy', () => {
    expect(resolveAgentOwnerIdentityId(roster, AGENT, OWNER)).toBe(OWNER);
    expect(resolveAgentOwnerIdentityId(roster, AGENT)).toBe(OWNER);
    expect(resolveAgentOwnerIdentityId({ members: [] }, AGENT)).toBeUndefined();
  });
});

describe('conversationHeldByHumanAuthority', () => {
  const held = (
    items: { authorId: string; body: string }[],
    ownerIdentityId: string | undefined = OWNER,
  ) =>
    conversationHeldByHumanAuthority({
      items,
      roster,
      ownerIdentityId,
      selfId: AGENT,
    });

  it('lets an agent-owner command override a member hold', () => {
    expect(
      held([
        { authorId: MEMBER_A, body: 'hold' },
        { authorId: OWNER, body: 'proceed' },
      ]),
    ).toBe(false);
  });

  it('lets a workspace admin command override a member hold', () => {
    expect(
      held([
        { authorId: MEMBER_A, body: 'hold' },
        { authorId: ADMIN, body: 'go ahead' },
      ]),
    ).toBe(false);
  });

  it('keeps a member hold against another member command', () => {
    expect(
      held([
        { authorId: MEMBER_A, body: 'hold' },
        { authorId: MEMBER_B, body: 'proceed' },
      ]),
    ).toBe(true);
  });

  it('lets the same member release their own hold', () => {
    expect(
      held([
        { authorId: MEMBER_A, body: 'hold' },
        { authorId: MEMBER_A, body: 'proceed' },
      ]),
    ).toBe(false);
  });

  it('ignores a member hold after the agent owner already ordered the action', () => {
    expect(
      held([
        { authorId: OWNER, body: 'merge now' },
        { authorId: MEMBER_A, body: 'hold' },
      ]),
    ).toBe(false);
  });

  it('ignores a member resume of the agent owner hold', () => {
    expect(
      held([
        { authorId: OWNER, body: 'hold' },
        { authorId: MEMBER_A, body: 'proceed' },
      ]),
    ).toBe(true);
  });

  it('ignores a workspace admin resume of the agent owner hold', () => {
    expect(
      held([
        { authorId: OWNER, body: 'do not merge' },
        { authorId: ADMIN, body: 'go ahead' },
      ]),
    ).toBe(true);
  });

  it('lets the agent owner override a workspace admin hold', () => {
    expect(
      held([
        { authorId: ADMIN, body: 'hold' },
        { authorId: OWNER, body: 'proceed' },
      ]),
    ).toBe(false);
  });

  it('keeps an admin hold against another workspace-manager command', () => {
    const workspaceOwner = {
      ...roster,
      members: [
        ...roster.members,
        {
          identityId: 'ff'.repeat(32),
          kind: 'human' as const,
          name: 'Pat',
          handle: 'pat',
          role: 'master' as const,
        },
      ],
    };
    expect(
      conversationHeldByHumanAuthority({
        items: [
          { authorId: ADMIN, body: 'hold' },
          { authorId: 'ff'.repeat(32), body: 'proceed' },
        ],
        roster: workspaceOwner,
        ownerIdentityId: OWNER,
        selfId: AGENT,
      }),
    ).toBe(true);
  });
});

describe('humanAuthorityContext', () => {
  it('names the connected owner and workspace managers from the roster, not from chat', () => {
    const context = humanAuthorityContext(roster, AGENT, OWNER);
    expect(context).toContain('Your owner: @lunchboxfortwo');
    expect(context).toContain('@ada (admin)');
    expect(context).toContain('Members: everyone else on this roster');
    expect(context).toContain(HUMAN_INSTRUCTION_AUTHORITY_RULE);
    expect(context).toContain('A member cannot stop an action your owner ordered');
    expect(context).not.toContain('@bananaman614305');
    expect(context).not.toContain('agentOwner');
    expect(context).not.toContain('workspaceRole');
  });

  it('does not invent an owner when the server named none', () => {
    const context = humanAuthorityContext(
      { members: roster.members.map((member) => ({ ...member, soul: undefined })) },
      AGENT,
    );
    expect(context).toContain('not named by the server for this agent');
    expect(context).not.toContain('Your owner: @lunchboxfortwo');
  });
});
