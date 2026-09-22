import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The parity contract, measured on painted pixels rather than on source text:
 * every surface that wears the Workspace picture seats it the same way. The
 * seat is a square centred inside the bezel with an even slab of tile showing
 * all the way round, and its radius is the one the tile derives — tile radius
 * less bezel (the inner radius), less that slab. Derived that way the seat's
 * curve is concentric with the bezel's inner curve, so the gap between picture
 * and brass is the same width at the corners as it is along the flats.
 *
 * The rails have always done this. The room-list header plate painted a square
 * picture with nothing rounding it, and Workspace settings cropped the picture
 * against the bezel itself; both now derive their seat from the same rule.
 */
function seatShims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const router = { back: () => undefined, push: () => undefined, replace: () => undefined };
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ communityId: 'alpha' });
    export const useRouter = () => ({ back: () => undefined, push: () => undefined });`,
    '@/modal': `export const Modal = { actionSheet: async () => undefined, alert: async () => undefined,
      confirm: async () => false };`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) });`,
    '@/buzz/avatar-upload': 'export const pickAndUploadAvatar = async () => undefined;',
    '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithEnabled: true });',
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() { return { surfaceSubscribe: async () => () => undefined }; }
    }`,
    '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation = async () => undefined;',
    // The one Workspace the proof reads, wearing the loud picture the rails wear.
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async workspace() {
        return {
          workspace: {
            id: 'alpha',
            name: 'Alpha',
            avatar: new URLSearchParams(location.search).get('picture'),
            visibility: 'public',
            createdAt: 1700000000,
          },
          viewer: { role: 'owner', permissions: { manage: true } },
          managerSettings: { rooms: [] },
        };
      }
      async chats() { return { chats: [] }; }
    }`,
  };
}

const PICTURE =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<rect width="96" height="96" fill="#ffffff"/>' +
      '</svg>',
  ).toString('base64');

describe.skipIf(!existsSync(CHROME))('Workspace picture seat parity', () => {
  it('seats the picture at the derived inner radius on every surface that wears it', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/workspace-picture-seat-proof.tsx'),
      mobile,
      shims: seatShims(mobile),
      width: 900,
      height: 560,
      query: `?picture=${encodeURIComponent(PICTURE)}`,
    });
    expect(status, stderr).toBe(0);
    for (const surface of ['desktop-rail', 'mobile-drawer', 'header-plate', 'settings-tile']) {
      expect(result).toContain(`${surface}: `);
      expect(result).not.toContain(`${surface}: NOT RENDERED`);
    }
    expect(result).not.toContain('NOT SEATED');
    expect(result).toContain(
      'desktop-rail: tile 48×48 radius 14 bezel 2, picture 36×36 seat radius 8 (derived 8), slab 4/4/4/4',
    );
    expect(result).toContain(
      'settings-tile: tile 76×76 radius 20 bezel 2, picture 64×64 seat radius 14 (derived 14), slab 4/4/4/4',
    );
    expect(result.startsWith('PASS'), result).toBe(true);
  }, 120_000);
});
