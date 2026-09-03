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

  it('inscribes one PR status line in corners and offers no merge or objective panel', () => {
    expect(source).toContain('<CornerStatusLine');
    expect(source).toContain('lifecycle={roomSurface?.cornerLifecycle}');
    expect(source).not.toContain('CornerLifecyclePanel');
    expect(source).not.toContain('CornerPlanPin');
    expect(source).not.toContain("monolithPhoneOperation('approveCornerMerge'");
    expect(source).not.toContain('approve-corner-merge');
    expect(source).toContain('<LedgerRoomUpdate');
  });

  it('lets the corner title wrap because the name is the objective verbatim', () => {
    expect(source).toContain('numberOfLines={isCorner ? 2 : 1}');
  });
});
