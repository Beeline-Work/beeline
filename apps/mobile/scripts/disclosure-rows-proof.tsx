import React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { TurnStepsLine } from '../sources/components/buzz/ActivityTimeline';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import snapshot from './transcript-event-room-snapshot.json';

const events = snapshot.runs[0].map((row) => ({
  id: row.id,
  text: row.text,
  timestamp: Number(row.timestamp),
  isUser: false,
  ...(row.card_type === 'daemon-fact' ? { daemonFact: row.card } : { githubEvent: row.card }),
})) as ChatDisplayMessage[];
const repository = foldPrLifecycleRuns(events)[0];
// Checks still use LedgerDisclosure; repository-only groups have a separate header.
const checks = {
  id: 'checks',
  notificationLifecycleRun: {
    subline: '',
    items: [
      {
        id: 'check',
        kind: 'check',
        state: 'Checks passed',
        kindLine: 'Checks',
        title: 'Required checks',
        actor: 'system',
        updatedBy: 'check',
      },
    ],
  },
} as ChatDisplayMessage;

export function DisclosureRowsProof() {
  const { theme } = useUnistyles();
  const body = { ...theme.buzz.type.body, color: theme.buzz.textPrimary };
  return (
    <View style={{ padding: 24, backgroundColor: theme.buzz.bgBase }}>
      <Text style={{ ...theme.buzz.type.hero, color: theme.buzz.textPrimary }}>#beeline</Text>
      <View style={{ marginTop: 24 }}>
        <Text style={body}>The update is ready to review.</Text>
        <TurnStepsLine
          items={[
            {
              kind: 'tool',
              id: 'read',
              title: 'Read file',
              toolKind: 'read',
              input: 'DESIGN.md',
              status: 'completed',
            },
          ]}
        />
      </View>
      <View testID="next-message" style={{ marginTop: 24 }}>
        <Text style={body}>Thanks. Keep the row easy to tap.</Text>
      </View>
      <View style={{ marginTop: 24 }}>
        <NotificationLifecycleCard
          message={repository}
          onOpenCorner={() => {}}
          onOpenUrl={() => {}}
        />
      </View>
      <View style={{ marginTop: 24 }}>
        <NotificationLifecycleCard message={checks} onOpenCorner={() => {}} onOpenUrl={() => {}} />
      </View>
      <View style={{ marginTop: 24 }}>
        <Text style={body}>The conversation continues here.</Text>
      </View>
    </View>
  );
}

export const repositoryId = repository.id;
