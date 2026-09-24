import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The corners page opens on the viewer's corners, folds everyone else's behind
 * "Others · N", and folds Archived, which reads ten at a time behind More.
 */
function shims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `export const useLocalSearchParams = () => ({ roomId: '11111111-1111-4111-8111-111111111111' });
    export const router = { push: () => undefined, replace: () => undefined, back: () => undefined };`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async corners(_id, options) { return globalThis.cornerSectionsView(options); }
    }`,
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() { return { surfaceSubscribe: async () => () => undefined }; }
    }`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
    '@/buzz/surface-storage': `export const surfaceAddress = () => 'address';
    export const mobileSurfaceCache = { read: async () => null, write: async () => undefined };`,
    '@/components/buzz/CommunityRail': `export const BuzzCommunityShell = ({ children }) => children;`,
    '@/components/buzz/NewCornerDialog': 'export const NewCornerDialog = () => null;',
    '@/sync/transport/monolith-operation':
      'export const phoneOperationFailureReason = (reason) => String(reason);',
  };
}

describe.skipIf(!existsSync(CHROME))('Corners page sections in a browser', () => {
  it('opens Mine, folds Others and Archived, and pages Archived ten at a time', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/corner-sections-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 390,
    });
    expect(status, stderr).toBe(0);
    if (process.env.PRINT_PROOF) console.log(result);
    expect(result).toContain('PASS');
  }, 90_000);
});
