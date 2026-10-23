import React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { TurnStepsLine } from '../sources/components/buzz/ActivityTimeline';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { LedgerGhostLine, LedgerRoomUpdate, LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { CornerStatusLine } from '../sources/components/buzz/CornerStatusLine';
import { LifecycleRecordCard } from '../sources/components/buzz/LifecycleCard';
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
// Every event run shares the same disclosure and group spacing.
const checks = {
  id: 'checks',
  notificationLifecycleRun: {
    subline: '',
    items: [
      {
        id: 'check',
        kind: 'check',
        state: 'Checks failed',
        kindLine: 'Checks',
        title: 'Required checks',
        actor: 'system',
        updatedBy: 'check',
        url: 'https://github.com/Beeline-Work/beeline/actions/runs/1',
      },
      { id: 'check-2', kind: 'check', state: 'Checks passed', kindLine: 'Checks', title: 'Typecheck', actor: 'system', updatedBy: 'check-2' },
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
              output: 'Design rules',
              files: [{ path: 'DESIGN.md' }],
              status: 'completed',
            },
            { kind: 'tool', id: 'test', title: 'Bash', toolKind: 'execute', command: 'npm test corner-state', status: 'exit 0', output: 'Passed', },
            { kind: 'tool', id: 'edit', title: 'Edit', toolKind: 'edit', files: [{ path: 'LedgerDisclosure.tsx' }], status: 'failed', output: 'Patch rejected', },
            { kind: 'tool', id: 'final', title: 'Read', toolKind: 'read', files: [{ path: 'PrLifecycleCard.tsx' }], status: 'completed', output: 'Source', },
          ]}
        />
      </View>
      <TurnStepsLine items={[{ kind: 'tool', id: 'closed', title: 'Bash', toolKind: 'execute', command: 'npm test', status: 'exit 0' }]} />
      <View testID="next-message" style={{ marginTop: 24 }}>
        <Text style={body}>Thanks. Keep the row easy to tap.</Text>
      </View>
      <View>
        <NotificationLifecycleCard
          message={repository}
          onOpenCorner={() => {}}
          onOpenUrl={() => {}}
        />
      </View>
      <View>
        <NotificationLifecycleCard message={checks} onOpenCorner={() => {}} onOpenUrl={() => {}} />
      </View>
      <View>
        <NotificationLifecycleCard message={{ id: 'payments', notificationLifecycleRun: { subline: '', items: [
          { id: 'pay-1', kind: 'payment', state: 'sent', kindLine: 'Payment', title: '$12 · example', actor: 'system', updatedBy: 'pay-1', url: 'https://example.com/receipt' },
          { id: 'pay-2', kind: 'payment', state: 'received', kindLine: 'Payment', title: '$8 · example', actor: 'system', updatedBy: 'pay-2' },
        ] } } as ChatDisplayMessage} onOpenCorner={() => {}} onOpenUrl={() => {}} />
        <NotificationLifecycleCard message={{ id: 'notices', notificationLifecycleRun: { subline: '', items: [
          { id: 'notice-1', kind: 'notice', state: 'posted', kindLine: 'Notice', title: 'Review ready', actor: 'system', updatedBy: 'notice-1' },
          { id: 'notice-2', kind: 'notice', state: 'posted', kindLine: 'Notice', title: 'Checks ready', actor: 'system', updatedBy: 'notice-2' },
        ] } } as ChatDisplayMessage} onOpenCorner={() => {}} onOpenUrl={() => {}} />
        <LedgerGhostLine label="12 lines of tool output" body={'npm test\nAll checks passed'} testID="inline-output" />
        <TranscriptCard tier="record" title="Run migration" code={'select 1;\nselect 2;'} foldCode codeTestID="script" testID="script-card" />
        <LifecycleRecordCard item={{ ...checks.notificationLifecycleRun!.items[0], id: 'single-check' }} timestamp={1} testID="single-check" onOpenCorner={() => {}} onOpenUrl={() => {}} />
        <LedgerRoomUpdate id="proof-update" line="Merge approved" stamp="16:22" />
        <LedgerSystemLine id="proof-system" text="Speedy joined the corner" stamp="16:21" />
        <CornerStatusLine archived={false} lifecycle={{ lifecycle: 'in-review', checks: 'pending', pr: { number: 2859, url: 'https://github.com/Beeline-Work/beeline/pull/2859', title: 'Review', targetBranch: 'main', headSha: 'a'.repeat(40) } }} onOpenPullRequest={() => {}} />
      </View>
    </View>
  );
}

export const repositoryId = repository.id;
