/** Release fixture for the Trusty Squire connect flow (Reproductions tunnel-dns,
 * squire-waiting, pairing-progress). Register this entry temporarily, with
 * scripts/proof-shims/metro.cjs standing in for expo-router, the live socket and sign-in. It
 * mounts the production Workbench Trusty Squire page, the pairing page and the
 * sign-in page, fed with the step labels and sign-in shape the squire helper
 * wrote to production on 2026-10-29. Switch screens with
 *   adb shell am start -a android.intent.action.VIEW -d 'beeline://proof?screen=<name>[&url=<page>]'
 */
import '../sources/unistyles';
import React, { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { UnistylesRuntime } from 'react-native-unistyles';
import { setProofParams } from './proof-shims/expo-router';
import { setWorkbenchSource } from '../sources/buzz/workbench-source';
import { MockWorkbenchSource } from '../sources/buzz/workbench-source.mock';
import type { ConnectorInstallState, WorkbenchView } from '../sources/buzz/workbench';
import ConnectorServiceScreen from '../sources/app/(app)/beeline/settings/workbench/service';
import ConnectTrustySquireScreen from '../sources/app/(app)/beeline/settings/workbench/connect';
import ConnectorSignInScreen from '../sources/app/(app)/beeline/settings/workbench/connect-signin';

UnistylesRuntime.setTheme('bone');

const SQUIRE = 'c7fc821c-68b7-4d4f-bd2c-45a4d6794231';
const scope = { workspaceId: 'workspace-proof', viewerId: 'human-proof' };
const done = (label: string) => ({ label, status: 'done' as const });
const pending = (label: string) => ({ label, status: 'pending' as const });
const virtual = (url: string) => ({ method: 'streamed' as const, url, browserLocation: { kind: 'virtual' as const, url } });

/** Each pairing moment, in the exact step order the helper posts it. */
const INSTALLS: Record<string, (url: string) => Omit<ConnectorInstallState, 'connectorId'>> = {
  'pair-start': () => ({ helperName: 'squire', steps: [pending('Install on helper'), pending('Connect provider account')], signIn: null, connected: false }),
  'pair-installing': () => ({ helperName: 'squire', steps: [done('helper reached')], signIn: null, connected: false }),
  'pair-pairing': () => ({ helperName: 'squire', steps: [done('helper reached'), done('trusty-squire 1.1.38 installed')], signIn: null, connected: false }),
  'pair-signin': (url) => ({ helperName: 'squire', connected: false, signIn: virtual(url),
    steps: [done('helper reached'), done('trusty-squire 1.1.38 installed'), pending('waiting for sign-in'), done('paired to workspace')] }),
  'pair-failed': () => ({ helperName: 'squire', signIn: null, connected: false,
    steps: [{ label: 'waiting for sign-in', status: 'failed', reason: 'the Trusty Squire sign-in page expired before it was used · tap Retry to open a new one' }] }),
};

function workbench(screen: string): WorkbenchView {
  const signedIn = screen === 'service-signed-in';
  const machine = (id: string, name: string, extra: object) => ({ id, name, online: true, status: 'not-added' as const, statusText: 'Google sign-in needed', ...extra });
  return {
    helpers: [{ id: SQUIRE, name: 'squire', online: true }], connectors: [], connections: [], apps: [],
    companies: { version: 1, suggestions: [], hasConnections: true, summary: { value: '1 connection' }, rows: [{
      id: 'squire-signin', name: 'Trusty Squire', domain: 'trustysquire.ai', kind: 'sign-in-service', section: 'signin',
      logo: { kind: 'image', uri: 'https://server.usebeeline.app/v1/company-logos/squire', plate: 'dark' },
      subtitle: '3 computers', items: [], alsoAvailable: [],
      status: 'Google sign-in needed',
      machines: [
        machine('muse', 'Muse', { online: false }),
        machine('pidoong', 'Pidoong', { online: false }),
        machine(SQUIRE, 'squire', signedIn
          ? { status: 'connected', signedInAs: 'lunchboxfortwo@gmail.com', statusText: 'lunchboxfortwo@gmail.com' }
          : { status: 'error', error: 'the Trusty Squire sign-in page expired before it was used · tap Retry to open a new one', statusText: 'Sign-in unavailable' }),
      ],
    }] },
  } as unknown as WorkbenchView;
}

function source(screen: string, url: string) {
  const mock = new MockWorkbenchSource();
  return Object.assign(mock, {
    readWorkbench: async () => workbench(screen),
    readInstallState: async ({ connectorId }: { connectorId: string }) =>
      ({ connectorId, ...(INSTALLS[screen] ?? INSTALLS['pair-signin']!)(url) }),
  });
}

function Proof() {
  const [route, setRoute] = useState<{ screen: string; url: string }>({ screen: 'service', url: 'https://example.invalid/' });
  useEffect(() => {
    const read = (link: string | null) => {
      if (!link) return;
      const query = new Map((link.split('?')[1] ?? '').split('&').filter(Boolean)
        .map((pair) => pair.split('=').map(decodeURIComponent) as [string, string]));
      setRoute({ screen: query.get('screen') ?? 'service', url: query.get('url') ?? 'https://example.invalid/' });
    };
    void Linking.getInitialURL().then(read);
    const subscription = Linking.addEventListener('url', ({ url }) => read(url));
    return () => subscription.remove();
  }, []);
  const { screen, url } = route;
  setWorkbenchSource(source(screen, url));
  if (screen.startsWith('service')) setProofParams({ ...scope, service: 'trusty-squire' });
  else if (screen.startsWith('pair-')) setProofParams({ ...scope, connectorId: 'trusty-squire', pairedConnectorId: `squire:${SQUIRE}` });
  else setProofParams({ ...scope, connectorId: `squire:${SQUIRE}`, connectorName: 'Trusty Squire', machineName: 'squire', url, method: 'streamed-page' });
  const Screen = screen.startsWith('service') ? ConnectorServiceScreen : screen.startsWith('pair-') ? ConnectTrustySquireScreen : ConnectorSignInScreen;
  return <Screen key={`${screen}:${url}`} />;
}

function App() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <Proof />
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

registerRootComponent(App);
