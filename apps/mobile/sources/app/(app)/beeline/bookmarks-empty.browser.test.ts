import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * Bookmarks is saved from a gesture, and the gesture is not the same one on
 * both surfaces: a phone long-presses a message, a desktop pointer reveals the
 * message's action strip. The empty state used to name both at once, so
 * whichever reader was looking got one instruction that did not work.
 */
function dataShims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
    export const useLocalSearchParams = () => ({ communityId: 'workspace-1' });
    export const useRouter = () => ({ back: () => undefined, push: () => undefined });`,
    '@/sync/transport/monolith-operation':
      'export const monolithPhoneOperation = async () => ({ bookmarks: [] });',
    '@/sync/transport/room-view-client': 'export class RoomViewClient {}',
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => null;`,
    '@/components/DesktopRoomInspector': 'export const DesktopRoomInspector = () => null;',
    '@expo/vector-icons': `import React from 'react';
    export const Ionicons = (props) => React.createElement('span', { 'data-icon': props.name });`,
  };
}

describe.skipIf(!existsSync(CHROME))('bookmarks empty state in a browser', () => {
  it.each([
    { surface: 'desktop', width: 1440, reads: 'Hover a message and press its bookmark mark.' },
    { surface: 'phone', width: 390, reads: 'Long press a message and pick Bookmark.' },
  ])('tells a $surface reader: $reads', async ({ surface, width, reads }) => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/bookmarks-empty-proof.tsx'),
      mobile,
      shims: dataShims(mobile),
      width,
      query: `?surface=${surface}`,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('PASS');
    expect(result).toContain(reads);
  }, 90_000);
});
