import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./[channelId].tsx', import.meta.url)), 'utf8');

describe('corner-open approval card design contract', () => {
  it('offers the decision only to requester, admin, or owner', () => {
    expect(source).toContain('cacheViewerPubkey === permission.requesterPubkey');
    expect(source).toContain("viewerChannelRole === 'admin'");
    expect(source).toContain("viewerChannelRole === 'owner'");
    expect(source).toContain('corner-approval-audience-wait');
  });

  it('keeps the mutated approved card visible and links it to the corner', () => {
    expect(source).not.toContain(
      "if (permission.status === 'allowed' && permission.subchannelId) return null",
    );
    expect(source).toContain('permission.subchannelId ? () => openCorner');
    expect(source).toContain('openCorner(permission.subchannelId!)');
  });
});
