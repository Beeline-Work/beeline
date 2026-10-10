import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * At desktop width the corners page is one cell per corner with Waiting /
 * Mine / All filters, the objective in full, the live workflow and Read brief.
 */
function shims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `export const useLocalSearchParams = () => ({ roomId: '11111111-1111-4111-8111-111111111111' });
    export const router = { push: (href) => globalThis.overviewPushes.push(href), replace: () => undefined, back: () => undefined };`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async corners(_id, options) { return globalThis.overviewView(options); }
      async room(id) { return globalThis.overviewRoom(id); }
    }`,
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() { return { surfaceSubscribe: async () => () => undefined }; }
    }`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: '${'a'.repeat(64)}' });`,
    '@/buzz/surface-storage': `export const surfaceAddress = () => 'address';
    export const mobileSurfaceCache = { read: async () => null, write: async () => undefined };`,
    '@/components/buzz/CommunityRail': `export const BuzzCommunityShell = ({ children }) => children;`,
    'expo-haptics': `export const notificationAsync = async () => undefined;
      export const impactAsync = async () => undefined;
      export const selectionAsync = async () => undefined;
      export const NotificationFeedbackType = { Success: 'success', Error: 'error' };
      export const ImpactFeedbackStyle = { Light: 'light' };`,
    '@/modal': 'export const Modal = { alert: (title, body) => { throw new Error(title + ": " + body); }, show: () => undefined };',
    // The Room's runs come from the one phone operation the page calls.
    '@/sync/transport/monolith-operation': `export const phoneOperationFailureReason = (reason) => String(reason);
      export const monolithPhoneOperation = async (name, input) => {
        globalThis.overviewOperations.push(name + ':' + input.roomId);
        return { workflows: globalThis.overviewWorkflows };
      };`,
    '@/sync/transport/live-connection':
      'export const sharedLiveConnection = () => ({ register: async () => () => undefined, whenSubscribed: async () => undefined });',
    '@/components/buzz/corner-brief-viewer':
      'export const openCornerBriefViewer = (brief) => globalThis.overviewBriefOpened(brief);',
  };
}

describe.skipIf(!existsSync(CHROME))('Corners overview on desktop in a browser', () => {
  it('shows one cell per corner, filters Waiting / Mine / All, and opens a brief', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/corner-overview-proof.tsx'),
      mobile,
      shims: shims(mobile),
      width: 1400,
      ...(process.env.PROOF_SCREENSHOT ? { screenshotPath: process.env.PROOF_SCREENSHOT } : {}),
    });
    expect(status, stderr).toBe(0);
    if (process.env.PRINT_PROOF) console.log(result);
    expect(result).toContain('PASS');
  }, 90_000);
});
