import React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { TurnStepsLine } from '../sources/components/buzz/ActivityTimeline';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';

export function TranscriptDividersProof() {
  const { theme } = useUnistyles();
  return <View style={{ padding: 24, backgroundColor: theme.buzz.bgBase }}>
    <Text style={{ ...theme.buzz.type.hero, color: theme.buzz.textPrimary }}>#beeline</Text>
    <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary, marginTop: 24 }}>The update is ready to review.</Text>
    <TurnStepsLine items={[
      { kind: 'tool', id: 'read', title: 'Read file', toolKind: 'read', input: 'DESIGN.md', status: 'completed' },
      { kind: 'tool', id: 'check', title: 'Check types', toolKind: 'execute', input: 'npm run typecheck', status: 'completed' },
    ]} />
    <NotificationLifecycleCard message={{ id: 'corner', notificationLifecycleRun: { subline: '', items: [
      { id: 'opened', title: 'transcript-dividers', state: 'Opened', kind: 'corner', kindLine: 'corner', cornerId: 'corner', actor: 'ruby', updatedBy: 'open' },
    ] } } as ChatDisplayMessage} onOpenCorner={() => {}} onOpenUrl={() => {}} />
    <TranscriptCard tier="record" title="Ready to merge" testID="divider-card"
      facts={[{ label: 'Repo', value: 'Beeline-Work/beeline' }, { label: 'PR', value: '#42' }, { label: 'Checks', value: 'Passed' }]}
      actions={[{ label: 'Approve merge', onPress: () => {}, primary: true }]} />
  </View>;
}
