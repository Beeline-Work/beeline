import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomWebhooksResult, PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from './SettingsRow';
import { WebhookRequestCard } from './WebhookRequestCard';

type Manage = PhoneOperationMap['manageRoomWebhook']['input'];
export function RoomWebhooksSettings({ roomId }: { roomId: string }) {
  const [data, setData] = useState<RoomWebhooksResult>();
  const [source, setSource] = useState('');
  const [secret, setSecret] = useState('');
  const [editingSecret, setEditingSecret] = useState<string>();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<string>();
  const reload = useCallback(async () => {
    try { setData(await monolithPhoneOperation('readRoomWebhooks', { roomId })); setError(''); }
    catch (e) { setError(phoneOperationFailureReason(e)); }
  }, [roomId]);
  useEffect(() => { void reload(); }, [reload]);
  async function manage(input: Omit<Manage, 'roomId'>) {
    setBusy(true); setError(''); setConfirm(undefined);
    try {
      const result = await monolithPhoneOperation('manageRoomWebhook', { ...input, roomId });
      if (result.url) setUrl(result.url);
      setSource(''); setSecret(''); setEditingSecret(undefined);
      await reload();
    } catch (e) { setError(phoneOperationFailureReason(e)); }
    finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    {error ? <View accessibilityRole="alert"><Text style={styles.error}>{error}</Text><SettingsRow title="Retry" tone="action" onPress={() => void reload()} /></View> : null}
    {!data && !error ? <Text style={styles.meta}>Loading webhooks…</Text> : null}
    <Text style={styles.body}>Incoming POSTs wake agents subscribed to the source. Payloads arrive as quoted outside data.</Text>
    {url ? <View style={styles.group} testID="webhook-url-once">
      <Text style={styles.body}>Save this URL now. It is shown once.</Text>
      <Text selectable style={styles.code}>{url}</Text>
      <SettingsRow title="Done" tone="action" onPress={() => setUrl('')} />
    </View> : null}
    <TextInput accessibilityLabel="Webhook source" placeholder="Source, for example price-feed" value={source}
      autoCapitalize="none" autoCorrect={false} maxLength={40} onChangeText={setSource} style={styles.input} testID="webhook-source" />
    <SettingsRow title="Create webhook" tone="action" disabled={busy || !/^[a-z0-9-]{1,40}$/.test(source)}
      onPress={() => void manage({ action: 'create', source })} testID="webhook-create" />
    {data?.requests.map((request) => <View key={request.requestId} style={styles.group}>
      <WebhookRequestCard request={request} roomId={roomId} canManage
        signingSecret={editingSecret === request.requestId ? secret : undefined}
        onDecided={() => { setSecret(''); setEditingSecret(undefined); void reload(); }} />
      <TextInput accessibilityLabel={`Signing secret for ${request.source}`} secureTextEntry autoCapitalize="none"
        value={editingSecret === request.requestId ? secret : ''} onChangeText={(v) => { setEditingSecret(request.requestId); setSecret(v); }} style={styles.input} placeholder="Optional signing secret" />
      {editingSecret === request.requestId && secret ? <>
        <Text style={styles.meta}>Approve keeps the signing secret private.</Text>
        <SettingsRow title="Approve and share signing secret with agent" tone="action" disabled={busy} onPress={() => {
          setBusy(true);
          void monolithPhoneOperation('decideWebhookRequest', { roomId, webhookRequestId: request.requestId, approve: true, signingSecret: secret, revealSecret: true })
            .then(() => { setSecret(''); return reload(); }).catch((e) => setError(phoneOperationFailureReason(e))).finally(() => setBusy(false));
        }} />
      </> : null}
    </View>)}
    {data?.sources.length === 0 ? <Text style={styles.meta}>No webhook sources yet.</Text> : null}
    {data?.sources.map((hook) => <View key={hook.id} style={styles.group}>
      <SettingsRow title={hook.source} value={hook.revoked ? 'Revoked' : hook.signed ? 'Signed' : 'Live'} />
      {!hook.revoked ? <>
        <SettingsRow title="Rotate URL" tone="action" disabled={busy} onPress={() => setConfirm(`rotate:${hook.id}`)} />
        <SettingsRow title={hook.signed ? 'Change signing secret' : 'Set signing secret'} tone="action" disabled={busy}
          onPress={() => { setEditingSecret(hook.id); setSecret(''); }} />
        {editingSecret === hook.id ? <>
          <TextInput accessibilityLabel={`Signing secret for ${hook.source}`} secureTextEntry autoCapitalize="none" value={secret}
            onChangeText={setSecret} style={styles.input} placeholder="Signing secret" />
          <SettingsRow title="Save secret" tone="action" disabled={busy || !secret} onPress={() => void manage({ action: 'secret', webhookId: hook.id, signingSecret: secret })} />
        </> : null}
        {hook.signed ? <SettingsRow title="Clear signing secret" disabled={busy} onPress={() => setConfirm(`secret:${hook.id}`)} /> : null}
        <SettingsRow title="Revoke webhook" tone="destructive" disabled={busy} onPress={() => setConfirm(`revoke:${hook.id}`)} />
        {confirm?.endsWith(hook.id) ? <>
          <Text style={styles.body}>{confirm.startsWith('secret:') ? 'Unsigned POSTs will be accepted.' : 'The current URL will stop working immediately.'}</Text>
          <SettingsRow title="Confirm" tone="destructive" disabled={busy} onPress={() => void manage({ action: confirm.split(':')[0] as Manage['action'], webhookId: hook.id, signingSecret: null })} />
          <SettingsRow title="Cancel" onPress={() => setConfirm(undefined)} />
        </> : null}
      </> : null}
    </View>)}
    {data?.deliveries.length ? <View style={styles.group}>
      <Text style={styles.body}>Recent deliveries</Text>
      {data.deliveries.map((delivery) => <SettingsRow key={delivery.id} title={delivery.source}
        value={delivery.delivered ? `${delivery.delivered} woken` : 'No consumer'} description={new Date(delivery.receivedAt*1000).toLocaleString()} />)}
    </View> : null}
  </ScrollView>;
}
const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.buzz.space.md, gap: theme.buzz.space.md },
  group: { gap: theme.buzz.space.sm },
  body: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  meta: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  error: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.dialogDanger },
  code: { ...Typography.mono(), ...theme.buzz.type.machine, color: theme.buzz.textPrimary },
  input: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textPrimary,
    backgroundColor: theme.buzz.bgRaised, padding: theme.buzz.space.md, borderRadius: theme.buzz.radius },
}));
