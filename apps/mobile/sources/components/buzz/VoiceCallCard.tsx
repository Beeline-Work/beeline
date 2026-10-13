import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type VoiceCall, type RoomViewIdentity, voiceDuration } from '@beeline/api-contract/phone';

export function VoiceCallCard({ call, joined, onJoin, agents = [] }: { call: VoiceCall; joined: boolean; onJoin(): void;
  agents?: readonly RoomViewIdentity[] }) {
  const [now, setNow] = React.useState(() => Date.now() / 1000);
  React.useEffect(() => {
    if (call.endedAt) return;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(timer);
  }, [call.endedAt]);
  const duration = voiceDuration((call.endedAt ?? now) - call.startedAt);
  if (call.endedAt) return <Text style={styles.ended} testID="voice-call-ended">Conversation ended · {duration}</Text>;
  return <View style={styles.card} testID="voice-call-card">
    <View style={styles.copy}><Text style={styles.title}>Conversation mode · {duration}</Text>
      <Text style={styles.people} numberOfLines={1}>{[...call.participants, ...agents].map(p => p.name).join(', ')}</Text></View>
    {!joined && <Pressable onPress={onJoin} accessibilityRole="button" accessibilityLabel="Join Conversation mode" style={styles.join} testID="voice-call-join">
      <Text style={styles.joinText}>Join</Text></Pressable>}
  </View>;
}
const styles = StyleSheet.create(theme => ({
  card: { flexDirection: 'row', alignItems: 'center', padding: 16, borderWidth: 1, borderRadius: 10,
    borderColor: theme.buzz.border, backgroundColor: theme.buzz.bgRaised }, copy: { flex: 1 },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  people: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  join: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  joinText: { ...theme.buzz.type.bodyStrong, color: theme.buzz.accent },
  ended: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
}));
