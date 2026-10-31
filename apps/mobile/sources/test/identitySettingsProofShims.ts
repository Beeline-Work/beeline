import path from 'node:path';
import { webProofShims } from './browserProof';

export function identitySettingsProofShims(mobile: string): Record<string, string> {
  return {
    ...webProofShims(mobile),
    'expo-router': `import React from 'react';
    export const router = { back: () => undefined, push: () => undefined, replace: () => undefined };
    export const useLocalSearchParams = () => ({});
    export const useFocusEffect = (effect) => React.useEffect(effect, [effect]);
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
    '@/auth/github-installation-host': `export const runHostGitHubInstallationSession = async () => {
      throw new Error('OAuth must not run in the identity picture geometry proof');
    };`,
    '@/auth/google-auth-session': `export const pendingGoogleLinkIdentity = async () => null;
    export const resumeGoogleSignIn = async () => null;
    export const runGoogleSignIn = async () => { throw new Error('OAuth must not run in the identity picture geometry proof'); };
    export const completeGoogleAccountLink = async () => { throw new Error('OAuth must not run in the identity picture geometry proof'); };`,
    '@/auth/monolith-session': `export class MonolithRequestTimeoutError extends Error {}
    export class MonolithSessionChangedError extends Error {}
    export const monolithSession = { signOut: async () => undefined };`,
    '@/buzz/community-storage': `export const loadActiveCommunityId = async () => null;
    export const watchActiveCommunityId = (_pubkey, listener) => {
      void Promise.resolve(null).then(listener);
      return () => undefined;
    };`,
    '@/buzz/person-name': `export const ensurePersonNameForWorkspace = async () => ({ name: 'Captain' });
    export const loadPreferredPersonName = async () => 'Captain';
    export const savePreferredPersonName = async () => undefined;`,
    '@/buzz/runtime-config': `export const getBuzzRuntimeConfig = () => ({ relayUrl: 'https://relay.test' });`,
    '@/buzz/connectors-model': `export const workbenchSummary = () => ({ value: '0 connected' });`,
    '@/buzz/workbench-source': `export const getWorkbenchSource = () => ({ readWorkbench: async () => ({ connections: [] }) });`,
    '@/buzz/room-open-trace': `export const roomOpenTraceEnabled = () => false; export const markRoomOpen = () => undefined;`,
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
      if (name === 'readIdentitySettings') return {
        identity: { personId: 'a'.repeat(64), face: 'fox', pushLevel: 'attention', handle: 'captain', name: 'Captain' },
        workspaces: { workspaces: [] },
      };
      if (name === 'getManagedIdentity') return { personId: 'a'.repeat(64), face: 'fox', pushLevel: 'attention', handle: 'captain', name: 'Captain' };
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
    '@/push/push-level-storage': `export const saveStoredPushLevel = async () => undefined;
      export const watchStoredPushLevel = () => () => undefined;`,
    '@/buzz/identity-live': `export const subscribeOwnIdentityChange = () => () => undefined;`,
    '@/push/presented-notifications': `export const reconcilePresentedNotificationBadge = async () => undefined;`,
    '@/sync/pushRegistration': `export const getPushPermissionInfo = async () => ({ status: 'granted', granted: true, canAskAgain: true });`,
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
    export const PixelLoader = () => null;`,
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
