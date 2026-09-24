import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The corners page and the desktop rail open on "Mine": only corners the
 * viewer commissioned or that await them. Turning it off on either surface
 * turns it off on both, and the device keeps the choice.
 */
function shims(mobile: string): Record<string, string> {
  const fixture = path.join(mobile, 'scripts/mine-corners-fixture');
  return {
    ...webProofShims(mobile),
    'expo-router': `export const useLocalSearchParams = () => ({ roomId: '11111111-1111-4111-8111-111111111111' });
    export const router = { push: () => undefined, replace: () => undefined, back: () => undefined };`,
    '@/sync/transport/room-view-client': `import { MINE_CORNERS_FIXTURE } from '${fixture}';
    export class RoomViewClient { async corners() { return MINE_CORNERS_FIXTURE; } }`,
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

describe.skipIf(!existsSync(CHROME))('Mine corners in a browser', () => {
  it('opens on Mine and flips the page and rail together', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/mine-corners-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 1280,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('PASS');
  }, 90_000);

  it('opens on all corners when the device remembers Mine off', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/mine-corners-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 1280,
      query: '?saved=all',
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('PASS');
  }, 90_000);
});
