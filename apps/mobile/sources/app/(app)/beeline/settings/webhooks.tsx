import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { PageHeader } from '@/components/buzz/PageHeader';
import { RoomWebhooksSettings } from '@/components/buzz/RoomWebhooksSettings';
import { Typography } from '@/constants/Typography';

export default function Webhooks() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const insets = useSafeAreaInsets();
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity || !roomId) throw new Error('Sign in and open a Room to manage webhooks.');
      const room = await new RoomViewClient({ baseUrl: await getEffectiveRelayUrl(), identity }).room(roomId);
      if (!room.viewer.permissions.manage && room.viewer.role !== 'owner' && room.viewer.role !== 'admin') throw new Error('Room admin required');
      setAllowed(true);
    })().catch((e) => setError(String(e)));
  }, [roomId]);
  return <View style={[styles.screen, { paddingTop: insets.top }]}>
    <PageHeader title="Webhooks" backAccessibilityLabel="Back to Room" onBack={() => router.back()} />
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {allowed ? <RoomWebhooksSettings roomId={roomId} /> : !error ? <Text style={styles.meta}>Loading Room…</Text> : null}
  </View>;
}
const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  error: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.dialogDanger, padding: theme.buzz.space.md },
  meta: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, padding: theme.buzz.space.md },
}));
