/** Disposable fixture: production controls and phone transport against the built local MCP server. */
import 'react-native-get-random-values';
import React from 'react';
import { registerRootComponent } from 'expo';
import { ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { setAppAppearance } from '../sources/unistyles';
require('../sources/unistyles');
import { AiClientsSection } from '../sources/components/buzz/AiClientsSection';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { LedgerSteer } from '../sources/components/buzz/Ledger';
import { Button } from '../sources/components/buzz/Button';
import { monolithPhoneOperation } from '../sources/sync/transport/monolith-operation';
import { monolithSession } from '../sources/auth/monolith-session';
import type { WorkbenchView } from '@beeline/api-contract/workbench';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
const origin = process.env.EXPO_PUBLIC_BUZZY_MONOLITH_URL ?? 'http://10.0.2.2:35513';
setAppAppearance('light');
let phoneToken = '';
monolithSession.fetch = (input, init = {}) => fetch(origin + new URL(String(input)).pathname, {
  ...init, headers: { ...init.headers, authorization: `Bearer ${phoneToken}` },
});
function Proof() {
  const [view, setView] = React.useState<WorkbenchView>();
  const [messages, setMessages] = React.useState<readonly RoomViewMessage[]>([]);
  const [page, setPage] = React.useState<'clients' | 'messages'>('clients');
  const [status, setStatus] = React.useState('Loading local reviewer account…');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  async function refresh() {
    setView(await monolithPhoneOperation('readWorkbench', { workspaceId: '11111111-1111-4111-8111-111111111111' }));
    const result = await fetch(origin + '/proof/status').then(r => r.json());
    setStatus(result.status === 401 ? 'Disconnected · next MCP call returned 401' : 'Connected');
  }
  React.useEffect(() => { void fetch(origin + '/proof/bootstrap').then(r => r.json()).then(async config => {
    phoneToken = config.phoneToken;
    await refresh();
    const res = await fetch(origin + `/v1/phone/rooms/${config.room}`, { headers: { authorization: `Bearer ${phoneToken}` } });
    const room = await res.json(); setMessages(room.messages ?? []);
  }).catch(error => setStatus(String(error))); }, []);
  if (!loaded) return null;
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><KeyboardProvider>
    <View style={{ flex: 1, backgroundColor: '#F3EEE4', paddingTop: 40 }}>
      <PageHeader prominent eyebrow={page === 'clients' ? 'Settings' : undefined} title={page === 'clients' ? 'Connectors' : '#connector-demo'} onBack={() => setPage('clients')} />
      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {page === 'clients' ? <AiClientsSection clients={view?.aiClients ?? []} onChanged={refresh} /> : messages.map(message =>
          <LedgerSteer key={message.id} itemId={message.id} bodyText={message.text} bodyTestID="proof-message" chronological
            byline={{ name: message.author.name, stamp: '20:43', isViewer: message.author.kind === 'human' }} />)}
        <Text style={{ marginTop: 24, color: '#4A4038' }}>{status}</Text>
        <Button label={page === 'clients' ? 'Show Room messages' : 'Show Connectors'} onPress={() => setPage(page === 'clients' ? 'messages' : 'clients')} />
      </ScrollView>
    </View>
  </KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Proof);
