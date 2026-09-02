import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { Typography } from '@/constants/Typography';
import { MonoButton } from './MonoHull';

function checksLine(checks: CornerLifecycleView['checks']): string {
  switch (checks) {
    case 'passing':
      return 'TESTS PASSED';
    case 'failing':
      return 'TESTS FAILED';
    case 'pending':
      return 'TESTS RUNNING';
    default:
      return 'TEST RESULTS UNKNOWN';
  }
}

function checkMark(status: 'pending' | 'passed' | 'failed'): string {
  return status === 'passed' ? '✓' : status === 'failed' ? '×' : '…';
}

export const CornerLifecyclePanel = React.memo(function CornerLifecyclePanel({
  lifecycle,
  archived,
  canApprove,
  approving = false,
  approvalResult,
  onOpenPullRequest,
  onApprove,
}: {
  lifecycle?: CornerLifecycleView;
  archived: boolean;
  canApprove: boolean;
  approving?: boolean;
  approvalResult?: string;
  onOpenPullRequest(url: string): void;
  onApprove(force: boolean): void;
}) {
  const pullRequest = lifecycle?.pr;
  const checks = lifecycle?.checksSummary?.checks ?? [];
  const checksStatus = lifecycle?.checksSummary?.status ?? lifecycle?.checks ?? 'unknown';
  const mergeConflict = pullRequest?.mergeability === 'dirty';
  if (!pullRequest && !archived) return null;
  return (
    <View style={styles.panel} testID="corner-lifecycle-panel">
      <View style={styles.statusRow}>
        <Text style={styles.status} testID="corner-test-result">
          {checksLine(checksStatus)}
        </Text>
        {archived ? (
          <Text style={styles.landed}>
            {lifecycle?.outcome === 'landed' || pullRequest?.mergedAt
              ? 'LANDED · READ-ONLY'
              : 'ARCHIVED · READ-ONLY'}
          </Text>
        ) : mergeConflict ? (
          <Text style={styles.conflict}>MERGE CONFLICT</Text>
        ) : null}
      </View>
      {checks.slice(0, 4).map((check) => (
        <Text
          key={`${check.name}:${check.status}`}
          numberOfLines={1}
          style={[styles.check, check.status === 'failed' && styles.checkFailed]}
          testID={`corner-check-${check.name}`}
        >
          {checkMark(check.status)} {check.name}
          {check.conclusion ? ` · ${check.conclusion}` : ''}
        </Text>
      ))}
      {checks.length > 4 ? (
        <Text style={styles.moreChecks}>+{checks.length - 4} MORE CHECKS ON GITHUB</Text>
      ) : null}
      {pullRequest ? (
        <Pressable
          accessibilityLabel={`Open pull request ${pullRequest.number} on GitHub`}
          accessibilityRole="link"
          onPress={() => onOpenPullRequest(pullRequest.url)}
          testID="corner-pull-request-link"
        >
          <Text numberOfLines={1} style={styles.link}>
            PR #{pullRequest.number} · {pullRequest.title} ↗
          </Text>
        </Pressable>
      ) : null}
      {pullRequest && canApprove && !archived ? (
        <MonoButton
          disabled={approving || mergeConflict}
          label={
            approving
              ? 'APPROVING…'
              : checksStatus === 'failing'
                ? 'APPROVE ANYWAY'
                : 'APPROVE MERGE'
          }
          loading={approving}
          onPress={() => onApprove(checksStatus === 'failing')}
          testID="approve-corner-merge"
        />
      ) : null}
      {approvalResult ? (
        <Text accessibilityLiveRegion="polite" style={styles.result} testID="corner-merge-result">
          {approvalResult}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    panel: {
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    status: { ...Typography.mono('semiBold'), color: hull.textMuted, fontSize: 10 },
    landed: { ...Typography.mono('semiBold'), color: hull.ledgerQuiet, fontSize: 9 },
    conflict: { ...Typography.mono('semiBold'), color: hull.danger, fontSize: 9 },
    check: { ...Typography.mono(), color: hull.ledgerQuiet, fontSize: 10, lineHeight: 15 },
    checkFailed: { color: hull.danger },
    moreChecks: { ...Typography.mono(), color: hull.ledgerGhost, fontSize: 9 },
    link: { ...Typography.mono('semiBold'), color: hull.accent, fontSize: 11, lineHeight: 17 },
    result: { ...Typography.default(), color: hull.textMuted, fontSize: 11, lineHeight: 16 },
  };
});
