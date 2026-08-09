import { describe, expect, it } from 'vitest';
import { buildCommunityInviteUrl, parseCommunityInviteToken } from './community-invite';

const token = `bzi_${'ab'.repeat(32)}`;

describe('community invite links', () => {
  it('builds the public buzzrouter join URL', () => {
    expect(buildCommunityInviteUrl(token)).toBe(`https://buzzrouter.com/join/${token}`);
  });

  it('accepts public, custom-scheme, and raw invite values', () => {
    expect(parseCommunityInviteToken(token)).toBe(token);
    expect(parseCommunityInviteToken(`https://buzzrouter.com/join/${token}`)).toBe(token);
    expect(parseCommunityInviteToken(`buzzy://join/${token}`)).toBe(token);
  });

  it('rejects unrelated hosts and malformed tokens', () => {
    expect(parseCommunityInviteToken(`https://example.com/join/${token}`)).toBeNull();
    expect(parseCommunityInviteToken('bzi_short')).toBeNull();
    expect(parseCommunityInviteToken(undefined)).toBeNull();
  });
});
