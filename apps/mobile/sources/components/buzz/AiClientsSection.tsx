import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AiClientConnection } from '@beeline/api-contract/workbench';
import { Button } from './Button';
import { SettingsRow } from './SettingsRow';
import { ServiceMark } from './ServiceMark';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { HullActionSheetModal, HullActionSheetCancel } from './HullActionSheet';

function permissions(scopes: readonly string[]) {
  return scopes.includes('rooms:write') ? scopes.includes('rooms:read') ? 'Reads and posts' : 'Posts as you' : 'Reads only';
}
function date(seconds: number) { return new Date(seconds * 1000).toLocaleDateString(); }

export function AiClientsSection({ clients, onChanged }: {
  clients: readonly AiClientConnection[]; onChanged: () => unknown;
}) {
  const [selected, setSelected] = useState<AiClientConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function disconnect() {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      const { monolithPhoneOperation } = await import('@/sync/transport/monolith-operation');
      await monolithPhoneOperation('disconnectAiClient', { clientId: selected.clientId });
      setSelected(null); await onChanged();
    } catch { setError('Could not disconnect this client. Try again.'); }
    finally { setBusy(false); }
  }
  if (!clients.length && !selected) return null;
  return <View testID="connectors-ai-clients">
    <RoomListSectionHeader title="AI clients" inset="content" spacing="flush" />
    {clients.map(client => <SettingsRow appBoard key={client.clientId} title={client.name}
      description={`${permissions(client.scopes)} · connected ${date(client.connectedAt)} · ${client.lastUsedAt ? `used ${date(client.lastUsedAt)}` : 'not used yet'}`}
      leading={<ServiceMark company={client.name} mark={client.logo ? { kind: 'image', uri: client.logo, plate: 'light' } : { kind: 'monogram' }} />}
      chevron="right" onPress={() => { setError(null); setSelected(client); }} testID={`ai-client-${client.clientId}`} />)}
    <HullActionSheetModal visible={Boolean(selected)} title={`Disconnect ${selected?.name ?? 'client'}?`}
      onClose={() => { if (!busy) setSelected(null); }} testID="ai-client-disconnect-sheet">
      <Text style={styles.description}>{selected?.name} can no longer read your Rooms or post as you. Messages it already sent stay in their Rooms.</Text>
      {error ? <SettingsRow title={error} action="Retry" onPress={() => void disconnect()} /> : null}
      <View style={styles.actions}><Button label="Disconnect" variant="danger" fullWidth loading={busy}
        onPress={() => void disconnect()} testID="ai-client-disconnect" /></View>
      <HullActionSheetCancel disabled={busy} onPress={() => setSelected(null)} />
    </HullActionSheetModal>
  </View>;
}
const styles = StyleSheet.create(theme => ({
  actions: { paddingHorizontal: theme.buzz.space.md },
  description: { ...theme.buzz.type.body, color: theme.buzz.textSecondary, padding: theme.buzz.space.md },
}));
