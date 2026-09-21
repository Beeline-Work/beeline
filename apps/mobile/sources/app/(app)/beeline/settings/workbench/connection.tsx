import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import {
  connectionCreatedByLine,
  connectionGrantsLine,
  connectionHostsLine,
  type ConnectionDetailView,
} from '@/buzz/workbench';

function singleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Key detail (report §5, story 3): what a tool's vault holds for one key —
 * hosts, who created it, the grants with their kinds, the spend cap — plus
 * its ledger rows, read from the tool's audit. Revoke all grants is a tool
 * command available only to the human who provisioned the key, behind an
 * explicit confirmation. Captain ruling 2026-09-15: user-visible copy says
 * Key; the data model (`WorkbenchConnection`, `ref`) keeps its names.
 */
export default function ConnectionDetailScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    ref?: string | string[];
  }>();
  const workspaceId = singleParam(params.workspaceId) ?? '';
  const viewerId = singleParam(params.viewerId) ?? '';
  const ref = singleParam(params.ref) ?? '';
  const [detail, setDetail] = useState<ConnectionDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokedLine, setRevokedLine] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getWorkbenchSource()
      .readConnectionDetail({ workspaceId, ref, viewerId })
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setError('Key not found — it belongs to another member or no longer exists');
        } else {
          setDetail(result);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Key unavailable right now');
      });
    return () => {
      cancelled = true;
    };
  }, [ref, viewerId, workspaceId]);

  const revoke = useCallback(async () => {
    if (!detail) return;
    setRevoking(true);
    try {
      const { revoked } = await getWorkbenchSource().revokeAllGrants({ workspaceId, ref });
      setDetail({
        ...detail,
        grants: [],
        connection: { ...detail.connection, grantCount: 0 },
      });
      setRevokedLine(`Revoked ${revoked} ${revoked === 1 ? 'grant' : 'grants'}`);
      setConfirmRevoke(false);
    } catch {
      setError('Some grants could not be revoked — try again');
    } finally {
      setRevoking(false);
    }
  }, [detail, ref, workspaceId]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backButton}
          testID="connection-back"
        >
          <ChevronGlyph
            color={styles.backButtonText.color}
            direction="left"
            size={CHEVRON_BACK_SIZE}
          />
        </TouchableOpacity>
        <Text style={styles.title}>{detail?.connection.name ?? 'Key'}</Text>
        <Text style={styles.subtitle}>{detail?.connection.service ?? ''}</Text>
      </View>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {detail ? (
          <View testID="connection-detail-metadata">
            <SettingsRow disabled title="Hosts" value={connectionHostsLine(detail.connection)} />
            {detail.createdBy ? (
              <SettingsRow disabled title="Created by" value={connectionCreatedByLine(detail)} />
            ) : null}
            <SettingsRow
              disabled
              testID="connection-detail-grants"
              title="Grants"
              value={connectionGrantsLine(detail)}
            />
            <SettingsRow disabled title="Spend cap" value={detail.spendCap} />
          </View>
        ) : null}
        {detail ? (
          <View testID="connection-detail-ledger">
            <Text style={styles.sectionLabel}>Ledger</Text>
            {detail.ledger.map((row, index) => (
              <View key={`${row.at}-${index}`} style={styles.ledgerRow} testID={`connection-ledger-${index}`}>
                <Text style={styles.ledgerStamp}>{row.at}</Text>
                <Text style={styles.ledgerText} numberOfLines={1}>
                  {[row.actor, row.action].filter(Boolean).join(' ')}
                  {row.status ? ` · ${row.status}` : ''}
                  {row.bytes ? ` · ${row.bytes}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {detail && !confirmRevoke ? (
          <SettingsRow
            disabled={revoking}
            onPress={() => setConfirmRevoke(true)}
            testID="connection-revoke-grants"
            title="Revoke all grants"
            tone="destructive"
          />
        ) : null}
        {confirmRevoke ? (
          <View style={styles.confirm} testID="connection-revoke-confirm">
            <Text style={styles.confirmText}>Revoke every grant on this key?</Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => void revoke()}
              style={styles.confirmDanger}
              testID="connection-revoke-confirm-yes"
            >
              <Text style={styles.confirmDangerText}>{revoking ? 'Revoking…' : 'Revoke'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => setConfirmRevoke(false)}
              testID="connection-revoke-confirm-no"
            >
              <Text style={styles.confirmCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {revokedLine ? (
          <Text style={styles.savedMark} testID="connection-revoked-line">
            {revokedLine}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText} testID="connection-error">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    header: {
      minHeight: 66,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backButtonText: { color: hull.textPrimary },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary, flex: 1 },
    subtitle: { ...Typography.mono(), ...hull.type.meta, color: hull.textMuted },
    content: { flex: 1 },
    contentInner: { padding: hull.space.md, gap: hull.layout.sectionGap, paddingBottom: hull.space.xxl },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    ledgerRow: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    ledgerStamp: { ...Typography.mono(), ...hull.type.meta, color: hull.textMuted },
    ledgerText: { ...Typography.mono(), ...hull.type.meta, color: hull.textSecondary, flex: 1 },
    confirm: {
      borderWidth: 1,
      borderColor: hull.borderStrong,
      padding: hull.space.md,
      gap: hull.space.sm,
    },
    confirmText: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    confirmDanger: {
      minHeight: hull.layout.row,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: hull.dialogDanger,
    },
    confirmDangerText: { ...Typography.default(), ...hull.type.body, color: hull.dialogDanger },
    confirmCancelText: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
    savedMark: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
