import { describe, expect, it, vi } from 'vitest';
import {
  buildCommunityInviteUrl,
  createCommunityInviteUrl,
  parseCommunityInviteToken,
} from './community-invite';

const token = `bzi_${'ab'.repeat(32)}`;

describe('community invite links', () => {
  it('builds the public buzzrouter join URL', () => {
    expect(buildCommunityInviteUrl(token)).toBe(`https://buzzrouter.com/join/${token}`);
  });

  it('reuses the client invite flow and returns its shareable URL', async () => {
    const createInvite = vi.fn().mockResolvedValue({ token });

    await expect(createCommunityInviteUrl({ createInvite }, 'community-123')).resolves.toBe(
      `https://buzzrouter.com/join/${token}`,
    );
    expect(createInvite).toHaveBeenCalledWith('community-123');
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
