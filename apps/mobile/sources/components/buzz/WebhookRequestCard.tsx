import React, { useState, useEffect } from 'react';
import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WebhookRequestCard as Request } from '@beeline/api-contract/phone';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { TranscriptCard } from './TranscriptCard';
import { Typography } from '@/constants/Typography';

export function WebhookRequestCard({ request, roomId, canManage, signingSecret, onDecided }: {
  request: Request; roomId: string; canManage: boolean; signingSecret?: string; onDecided?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The decision's answer, shown only until the server row carries a status.
  const [decided, setDecided] = useState<Request['status'] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setDecided(null), [request.status]);
  const status = decided ?? request.status;
  const pending = status === 'pending' && request.expiresAt > Date.now()/1000;
  async function decide(approve: boolean) {
    setBusy(true); setError('');
    try {
      const result = await monolithPhoneOperation('decideWebhookRequest', {
        roomId, webhookRequestId: request.requestId, approve,
        ...(approve && signingSecret ? { signingSecret } : {}),
      });
      setDecided(result.status as Request['status']);
      onDecided?.();
    } catch (e) { setError(phoneOperationFailureReason(e)); }
    finally { setBusy(false); }
  }
  return <TranscriptCard tier="ask" title={`${request.agentName} requested webhook ${request.source}`} wrapTitle testID="webhook-request-card"
    subline={pending ? 'Room admin approval needed' : status === 'pending' ? 'Expired' : status}
    body={<Text style={styles.body}>{request.reason}</Text>}
    footerNote={error || 'URL sent once to agent'}
    footerNoteTone={error ? 'failed' : 'quiet'}
    actions={pending && canManage ? [
      { label: 'Deny', disabled: busy, onPress: () => void decide(false), testID: 'webhook-deny' },
      { label: 'Approve', primary: true, disabled: busy, loading: busy, onPress: () => void decide(true), testID: 'webhook-approve' },
    ] : []} />;
}
const styles = StyleSheet.create((theme) => ({
  body: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
