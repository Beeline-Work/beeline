import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./[channelId].tsx', import.meta.url)), 'utf8');
const variants = readFileSync(
  fileURLToPath(new URL('./RoomMessageVariants.tsx', import.meta.url)),
  'utf8',
);

describe('corner-open approval card design contract', () => {
  it('offers the decision only to requester, admin, or owner', () => {
    expect(variants).toContain('viewerPubkey === permission.requesterPubkey');
    expect(variants).toContain("viewerRole === 'admin'");
    expect(variants).toContain("viewerRole === 'owner'");
    expect(variants).toContain('corner-approval-audience-wait');
  });

  it('keeps the mutated approved card visible and links it to the corner', () => {
    expect(variants).not.toContain(
      "if (permission.status === 'allowed' && permission.subchannelId) return null",
    );
    expect(variants).toContain('permission.subchannelId ? () => onOpenCorner');
    expect(variants).toContain('onOpenCorner(permission.subchannelId!)');
  });
});
