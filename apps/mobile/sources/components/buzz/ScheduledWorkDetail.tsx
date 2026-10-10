import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from './SettingsRow';

/**
 * The parts a schedule's or subscription's own page is built from, cut from the
 * workflow run page (`workflow-run.tsx`) so the three read as one family: its
 * hairline section head (as "Steps" is drawn), its summary rail line, and the
 * settings rows every detail page shares — Runs, Agent(s), Where, then Stop.
 */
export function DetailSection({ title, testID }: { title: string; testID?: string }) {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionHead}>{title}</Text>
    </View>
  );
}

/** The run page's summary line: a human rail beside quiet copy. */
export function DetailRailLine({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.summaryLine}>
      <View style={styles.summaryRail} />
      <Text selectable style={styles.summary} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

/** Plain copy under a section head, at the summary line's size. */
export function DetailCopy({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <Text style={styles.copy} testID={testID}>
      {children}
    </Text>
  );
}

/** Runs, Agent or Agents, and Where: the same three rows on every detail page. */
export function ScheduledWorkFacts({
  runs,
  runsLabel = 'Runs',
  agents,
  where,
  testID = 'scheduled-work-facts',
}: {
  runs: string;
  runsLabel?: string;
  agents: readonly string[];
  where: string;
  testID?: string;
}) {
  return (
    <View style={styles.facts} testID={testID}>
      <SettingsRow description={runs} testID={`${testID}-runs`} title={runsLabel} />
      <SettingsRow
        description={agents.length ? agents.map((name) => `@${name}`).join(', ') : 'None'}
        testID={`${testID}-agents`}
        title={agents.length > 1 ? 'Agents' : 'Agent'}
      />
      <SettingsRow description={where} testID={`${testID}-where`} title="Where" />
    </View>
  );
}

/**
 * "Stop schedule" or "Stop subscription": one tap asks, a second confirms, the
 * same two steps the schedule list's STOP took.
 */
export function StopScheduledWork({
  label,
  onStop,
  working,
  testID,
}: {
  label: string;
  onStop: () => void;
  working: boolean;
  testID: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.facts}>
      {confirming ? (
        <>
          <SettingsRow
            disabled={working}
            onPress={onStop}
            testID={`${testID}-confirm`}
            title={`Confirm: ${label}`}
            tone="destructive"
          />
          <SettingsRow
            disabled={working}
            onPress={() => setConfirming(false)}
            testID={`${testID}-cancel`}
            title="Cancel"
            tone="quiet"
          />
        </>
      ) : (
        <SettingsRow
          disabled={working}
          onPress={() => setConfirming(true)}
          testID={testID}
          title={label}
          tone="destructive"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    minHeight: 32,
    marginTop: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  sectionHead: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  summaryLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.buzz.space.sm,
    marginHorizontal: theme.buzz.space.md,
    marginVertical: theme.buzz.space.md,
  },
  summaryRail: { alignSelf: 'stretch', width: 2, backgroundColor: theme.buzz.humanRail },
  summary: {
    ...theme.buzz.type.meta,
    flex: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
  },
  copy: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    marginHorizontal: theme.buzz.space.md,
    marginTop: theme.buzz.space.md,
  },
  // SettingsRow pads by `space.sm`; the page's copy sits at `space.md`.
  facts: { paddingHorizontal: theme.buzz.space.sm },
}));
