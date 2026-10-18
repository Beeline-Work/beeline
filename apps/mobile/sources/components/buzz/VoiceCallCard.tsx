import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { type VoiceCall, voiceDuration } from '@beeline/api-contract/phone';

/** The running call occupies its own row below the Room header. */
export function VoiceCallCard({ call, joined, onJoin, connecting = false, viewer }: {
  call: VoiceCall; joined: boolean; onJoin(): void; connecting?: boolean; viewer?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now() / 1000);
  React.useEffect(() => {
    if (call.endedAt) return;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [call.endedAt]);
  if (call.endedAt) return null;
  return <View style={styles.row} testID="voice-call-header">
    <View style={styles.pill}>
      <View style={styles.dot} />
      <Text style={styles.title} numberOfLines={1}>Call · {voiceDuration(now - call.startedAt)} · {call.participants
        .filter(p => p.kind === 'human').sort((a, b) => Number(b.pubkey === viewer) - Number(a.pubkey === viewer)).map(p => p.pubkey === viewer ? 'You' : p.name).join(', ')}</Text>
      {!joined && <Pressable onPress={onJoin} disabled={connecting} hitSlop={8}
        accessibilityState={{ busy: connecting }} accessibilityRole="button" accessibilityLabel="Join call"
        style={styles.join} testID="voice-call-join">
        <Text style={styles.joinText}>{connecting ? 'Joining…' : 'Join'}</Text>
      </Pressable>}
    </View>
  </View>;
}
const styles = StyleSheet.create(theme => ({
  row: { paddingHorizontal: 16, paddingVertical: 8 },
  pill: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8,
    borderWidth: 1, borderRadius: 10, borderColor: theme.buzz.border, backgroundColor: theme.buzz.bgRaised },
  dot: { width: 8, height: 8, borderRadius: 999, backgroundColor: theme.buzz.accent },
  title: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary, flex: 1 },
  join: { minWidth: 44, minHeight: 28, paddingHorizontal: 16, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center', backgroundColor: theme.buzz.textPrimary },
  joinText: { ...theme.buzz.type.meta, color: theme.buzz.bgRaised },
}));
