import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/**
 * The Settings identity tile is the same picture-in-a-frame geometry as the
 * Workspace settings tile, measured on painted pixels. Person photos stay
 * darkflighted in the product (`PHOTO_OVERRIDES_ENABLED`), so the proof paints
 * a loud square through a shimmed IdentityMark — a generated creature plate
 * hides the corners this seat exists to round.
 */
function seatShims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const router = { back: () => undefined, push: () => undefined, replace: () => undefined };
    export const useLocalSearchParams = () => ({});
    export const useRouter = () => ({ back: () => undefined, push: () => undefined });`,
    'expo-updates': `export const isEnabled = false;
    export const channel = null;
    export const updateId = null;
    export const checkForUpdateAsync = async () => ({ isAvailable: false });
    export const fetchUpdateAsync = async () => ({ isNew: false });
    export const reloadAsync = async () => undefined;`,
    '@/modal': `export const Modal = { actionSheet: async () => undefined, alert: async () => undefined,
      confirm: async () => false };`,
    '@/auth/buzz-identity-storage': `export const getEffectiveRelayUrl = async () => 'https://relay.test';
    export const loadBuzzIdentity = async () => ({ publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) });
    export const clearBuzzIdentity = async () => undefined;`,
    '@/auth/github-auth-session': `export const clearPendingGitHubSignInState = async () => undefined;`,
    '@/auth/monolith-session': `export const monolithSession = { signOut: async () => undefined };`,
    '@/buzz/community-storage': `export const loadActiveCommunityId = async () => null;`,
    '@/buzz/person-name': `export const ensurePersonNameForWorkspace = async () => ({ name: 'Captain' });
    export const loadPreferredPersonName = async () => 'Captain';
    export const savePreferredPersonName = async () => undefined;`,
    '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({ monolithEnabled: true, relayUrl: 'https://relay.test' });`,
    '@/buzz/workbench': `export const connectionsForViewer = () => [];`,
    '@/buzz/workbench-source': `export const getWorkbenchSource = () => ({ readWorkbench: async () => ({ connections: [] }) });`,
    '@/buzz/surface-storage': `export const clearMobileSurfaceStorage = async () => undefined;`,
    '@/buzz/room-open-trace': `export const roomOpenTraceEnabled = () => false;`,
    '@/sync/appConfig': `export const loadAppConfig = () => ({ releaseVersion: 'development', releaseSha: null });`,
    '@/sync/storage': `export const useLocalSettingMutable = (name) => [name === 'appearance' ? 'dark' : 'medium', () => undefined];`,
    '@/unistyles': `export const applyAppearanceChoice = () => undefined;
    export const setAppDisplay = () => undefined;`,
    '@/sync/transport': `export class BuzzRigTransport {
      async ensureClient() {
        return {
          surfaceSubscribe: async () => () => undefined,
          getGlobalPersonProfile: async () => ({ name: 'Captain', handle: 'captain' }),
        };
      }
    }`,
    '@/sync/transport/monolith-operation': `export const monolithPhoneOperation = async (name) => {
      if (name === 'getManagedIdentity') return { face: 'fox', pushLevel: 'mine', handle: 'captain', name: 'Captain' };
      return undefined;
    };`,
    '@/sync/transport/room-view-client': `export class RoomViewClient {
      async workspaces() { return { workspaces: [] }; }
    }`,
    '@/push/buzz-push-registration': `export const getBuzzPushEnabled = async () => true;
    export const getBuzzPushRegistrationState = async () => ({ registered: true, phase: 'ready' });
    export const registerBuzzPushNotifications = async () => ({ registered: true });
    export const setBuzzPushEnabled = async () => ({ registered: true });`,
    '@/push/buzz-push-status': `export const buzzPushPhaseDetail = () => null;
    export const pushSwitchValue = () => true;`,
    '@/push/push-level-storage': `export const saveStoredPushLevel = async () => undefined;`,
    '@/push/presented-notifications': `export const reconcilePresentedNotificationBadge = async () => undefined;`,
    '@/sync/pushRegistration': `export const getPushPermissionInfo = async () => ({ status: 'granted', granted: true, canAskAgain: true });`,
    '@/text': `export const t = (key) => key;`,
    '@/utils/open-external-url': `export const openExternalUrl = async () => undefined;`,
    '@/components/buzz/FacePickerSheet': `export const FacePickerSheet = () => null;`,
    '@/components/buzz/PushLevelSetting': `export const PushLevelSetting = () => null;`,
    '@/components/buzz/AppearanceSetting': `export const AppearanceSetting = () => null;`,
    '@/components/buzz/UiSizeSetting': `export const UiSizeSetting = () => null;`,
    '@/components/buzz/SettingsRow': `import React from 'react';
    export const SettingsRow = (props) => React.createElement('div', { 'data-testid': props.testID }, props.title);`,
    '@/components/buzz/MonoHull': `import React from 'react';
    export const HullSurface = ({ children, style }) => React.createElement('div', { style }, children);
    export const PixelGateReveal = ({ children }) => React.createElement(React.Fragment, null, children);
    export const PixelLoader = () => null;
    export const MonoButton = () => null;`,
    // Person photos stay darkflighted. The proof still needs a real square so
    // the corners this seat rounds are visible, the same way the Workspace
    // proof feeds a loud picture through IdentityMark.
    '@/components/buzz/IdentityMark': `import React from 'react';
    export const IdentityMark = (props) => {
      const picture = new URLSearchParams(location.search).get('picture');
      return React.createElement('img', {
        'data-testid': props.testID,
        src: picture,
        width: props.size,
        height: props.size,
        style: { width: props.size, height: props.size, display: 'block' },
      });
    };`,
  };
}

const PICTURE =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<rect width="96" height="96" fill="#ffffff"/>' +
      '<rect x="0" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="0" width="28" height="28" fill="#000000"/>' +
      '<rect x="0" y="68" width="28" height="28" fill="#000000"/>' +
      '<rect x="68" y="68" width="28" height="28" fill="#000000"/>' +
      '</svg>',
  ).toString('base64');

describe.skipIf(!existsSync(CHROME))('Settings identity picture seat', () => {
    it('seats the person identity tile at the derived inner radius', async () => {
    const mobile = process.cwd();
    const { result, status, stderr } = await runBrowserProof({
      entry: path.join(mobile, 'scripts/identity-picture-seat-proof.tsx'),
      mobile,
      shims: seatShims(mobile),
      width: 390,
      height: 844,
      query: `?picture=${encodeURIComponent(PICTURE)}`,
    });
    expect(status, stderr).toBe(0);
    expect(result).toContain('settings-identity: ');
    expect(result).not.toContain('NOT RENDERED');
    expect(result).not.toContain('NOT SEATED');
    expect(result.startsWith('PASS'), result).toBe(true);
  }, 120_000);
});
