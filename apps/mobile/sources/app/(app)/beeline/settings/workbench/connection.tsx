import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { StateDot } from '@/components/buzz/StateDot';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import {
  connectionCompany,
  connectionCreatedByLine,
  connectionDetailLabel,
  connectionDetailState,
  connectionFactDate,
  connectionGrantLimits,
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
  const [loadGeneration, setLoadGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
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
  }, [loadGeneration, ref, viewerId, workspaceId]);

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

  const company = detail ? connectionCompany(detail.connection) : '';
  const label = detail ? connectionDetailLabel(detail.connection) : undefined;
  const state = detail ? connectionDetailState(detail.connection) : undefined;
  const fieldNames = detail?.connection.fieldNames ?? [];
  const grantCount = detail?.grants.length ?? 0;
  const revokeQuestion = useMemo(
    () =>
      `Revoke ${grantCount === 1 ? 'this grant' : `all ${grantCount} grants`}? Agents using ` +
      'them will lose access to this key immediately.',
    [grantCount],
  );

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
        <Text style={styles.title}>Key</Text>
      </View>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {!detail && !error ? (
          <View style={styles.centered} testID="connection-loading">
            <SurfaceGlyphLoader testID="connection-loader" />
          </View>
        ) : null}
        {detail ? (
          <View style={styles.identity} testID="connection-detail-identity">
            <ServiceMark
              company={company}
              domain={detail.connection.faviconDomain}
              testID="connection-service-mark"
            />
            <View style={styles.identityCopy}>
              <Text numberOfLines={1} style={styles.identityTitle} testID="connection-service-name">
                {company}
              </Text>
              {label ? (
                <Text numberOfLines={1} style={styles.identityLabel} testID="connection-key-label">
                  {label}
                </Text>
              ) : null}
            </View>
            {state ? (
              <View style={styles.state} testID="connection-detail-state">
                <StateDot kind={state.glyph} />
                <Text
                  style={[
                    styles.stateText,
                    state.tone === 'danger' && styles.stateDanger,
                    state.tone === 'accent' && styles.stateAccent,
                  ]}
                >
                  {state.label}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {detail ? (
          <View testID="connection-detail-metadata">
            <Text style={styles.sectionLabel}>Vault</Text>
            <SettingsRow disabled title="Reference" description={detail.connection.ref} />
            <SettingsRow
              disabled
              title="Hosts"
              description={connectionHostsLine(detail.connection)}
            />
            <SettingsRow
              description={fieldNames.length ? fieldNames.join(', ') : 'none reported'}
              disabled
              testID="connection-detail-fields"
              title="Fields"
            />
            <SettingsRow
              disabled
              title="Created"
              value={connectionFactDate(detail.connection.createdAt)}
            />
            <SettingsRow
              disabled
              title="Last synced"
              value={connectionFactDate(detail.connection.lastSyncedAt)}
            />
            {detail.createdBy ? (
              <SettingsRow
                disabled
                title="Provisioned by"
                value={connectionCreatedByLine(detail)}
              />
            ) : null}
          </View>
        ) : null}
        {detail ? (
          <View testID="connection-detail-grants">
            <Text style={styles.sectionLabel}>Grants</Text>
            {detail.grants.length ? (
              detail.grants.map((grant) => (
                <SettingsRow
                  description={`Granted ${connectionFactDate(grant.createdAt)}`}
                  disabled
                  key={grant.grantId}
                  testID={`connection-grant-${grant.grantId}`}
                  title={grant.grantId}
                  value={connectionGrantLimits(grant)}
                />
              ))
            ) : (
              <SettingsRow disabled testID="connection-grants-empty" title="None" tone="quiet" />
            )}
          </View>
        ) : null}
        {detail ? (
          <View testID="connection-detail-ledger">
            <Text style={styles.sectionLabel}>Activity</Text>
            {detail.ledger.length ? (
              detail.ledger.map((row, index) => (
                <View
                  key={`${row.at}-${index}`}
                  style={styles.ledgerRow}
                  testID={`connection-ledger-${index}`}
                >
                  <View style={styles.ledgerCopy}>
                    <Text style={styles.ledgerText} numberOfLines={1}>
                      {[row.actor, row.action].filter(Boolean).join(' ') || 'Key used'}
                    </Text>
                    {[row.grant ? `grant ${row.grant}` : undefined, row.status, row.bytes].filter(
                      Boolean,
                    ).length ? (
                      <Text style={styles.ledgerMeta} numberOfLines={1}>
                        {[row.grant ? `grant ${row.grant}` : undefined, row.status, row.bytes]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.ledgerStamp}>{row.at}</Text>
                </View>
              ))
            ) : (
              <SettingsRow
                disabled
                testID="connection-activity-empty"
                title="No activity yet"
                tone="quiet"
              />
            )}
          </View>
        ) : null}
        {detail && grantCount > 0 ? (
          <View testID="connection-management">
            <Text style={styles.sectionLabel}>Manage</Text>
            {!confirmRevoke ? (
              <SettingsRow
                disabled={revoking}
                onPress={() => {
                  setError(null);
                  setConfirmRevoke(true);
                }}
                testID="connection-revoke-grants"
                title={grantCount === 1 ? 'Revoke grant' : 'Revoke all grants'}
                tone="destructive"
              />
            ) : null}
          </View>
        ) : null}
        {confirmRevoke ? (
          <View style={styles.confirm} testID="connection-revoke-confirm">
            <Text style={styles.confirmText}>{revokeQuestion}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ busy: revoking, disabled: revoking }}
              disabled={revoking}
              onPress={() => void revoke()}
              style={styles.confirmDanger}
              testID="connection-revoke-confirm-yes"
            >
              <Text style={styles.confirmDangerText}>{revoking ? 'Revoking…' : 'Revoke'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: revoking }}
              disabled={revoking}
              onPress={() => setConfirmRevoke(false)}
              style={styles.confirmCancel}
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
          <View style={styles.error} testID="connection-error-state">
            <Text accessibilityRole="alert" style={styles.errorText} testID="connection-error">
              {error}
            </Text>
            {!detail ? (
              <SettingsRow
                onPress={() => setLoadGeneration((generation) => generation + 1)}
                testID="connection-retry"
                title="Try again"
                tone="action"
              />
            ) : null}
          </View>
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
    content: { flex: 1 },
    contentInner: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    centered: { minHeight: 180, alignItems: 'center', justifyContent: 'center' },
    identity: {
      minHeight: hull.layout.row,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      paddingBottom: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    identityCopy: { flex: 1, minWidth: 0 },
    identityTitle: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    identityLabel: { ...Typography.mono(), ...hull.type.meta, color: hull.ledgerQuiet },
    state: { flexDirection: 'row', alignItems: 'center', gap: hull.space.xs },
    stateText: { ...Typography.mono(), ...hull.type.meta, color: hull.textSecondary },
    stateDanger: { color: hull.dialogDanger },
    stateAccent: { color: hull.accent },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    ledgerRow: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.sm,
      paddingVertical: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    ledgerCopy: { flex: 1, minWidth: 0 },
    ledgerStamp: { ...Typography.mono(), ...hull.type.meta, color: hull.textMuted },
    ledgerText: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    ledgerMeta: { ...Typography.mono(), ...hull.type.meta, color: hull.ledgerQuiet },
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
    confirmCancel: {
      minHeight: hull.layout.row,
      alignItems: 'center',
      justifyContent: 'center',
    },
    confirmCancelText: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
    savedMark: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    error: { gap: hull.space.xs },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger },
  };
});
