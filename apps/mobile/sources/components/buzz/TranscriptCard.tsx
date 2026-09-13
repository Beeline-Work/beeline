import React, { type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export type TranscriptCardTier = 'record' | 'ask';
export type TranscriptCardRowTone = 'settled' | 'waiting' | 'failed';

export type TranscriptCardRow = {
  id: string;
  state: string;
  title: string;
  kindLine: string;
  tone?: TranscriptCardRowTone;
  onPress?(): void;
};

export type TranscriptCardAction = {
  label: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  accessibilityRole?: 'button' | 'link';
};

export type TranscriptCardProps = {
  tier: TranscriptCardTier;
  title: ReactNode;
  subline?: ReactNode;
  sublineTestID?: string;
  stamp?: string;
  identity?: ReactNode;
  body?: ReactNode;
  quietBody?: boolean;
  rows?: readonly TranscriptCardRow[];
  code?: ReactNode;
  codeTestID?: string;
  codePath?: string;
  footerNote?: ReactNode;
  footerNoteTestID?: string;
  footerNoteTone?: 'quiet' | 'failed';
  actions?: readonly TranscriptCardAction[];
  testID?: string;
};

/** The single frame and anatomy for every structured card in a transcript. */
export function TranscriptCard({
  tier,
  title,
  subline,
  sublineTestID,
  stamp,
  identity,
  body,
  quietBody = false,
  rows = [],
  code,
  codeTestID,
  codePath,
  footerNote,
  footerNoteTestID,
  footerNoteTone = 'quiet',
  actions = [],
  testID,
}: TranscriptCardProps) {
  const hasFooter = footerNote !== undefined || actions.length > 0;
  return (
    <View style={[styles.frame, tier === 'ask' && styles.ask]} testID={testID}>
      <View style={styles.head}>
        {identity ? <View style={styles.identity}>{identity}</View> : null}
        <View style={styles.headCopy}>
          <View style={styles.titleLine}>
            <Text ellipsizeMode="tail" numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {stamp ? <Text style={styles.stamp}>{stamp}</Text> : null}
          </View>
          {subline ? (
            <Text style={styles.subline} testID={sublineTestID}>
              {subline}
            </Text>
          ) : null}
        </View>
      </View>
      {body ? <Text style={[styles.body, quietBody && styles.bodyQuiet]}>{body}</Text> : null}
      {code !== undefined ? (
        <View style={[styles.code, tier === 'ask' && styles.askCode]} testID={codeTestID}>
          {codePath ? <Text style={styles.codePath}>{codePath}</Text> : null}
          <Text selectable style={styles.codeText}>
            {code}
          </Text>
        </View>
      ) : null}
      {rows.length ? (
        <View style={styles.rows}>
          {rows.map((row) => {
            const content = (
              <>
                <Text
                  style={[
                    styles.rowState,
                    row.tone === 'waiting' && styles.rowStateWaiting,
                    row.tone === 'failed' && styles.rowStateFailed,
                  ]}
                >
                  {row.state}
                </Text>
                <View style={styles.rowCopy}>
                  <Text ellipsizeMode="tail" numberOfLines={1} style={styles.rowTitle}>
                    {row.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.rowKind}>
                    {row.kindLine}
                  </Text>
                </View>
              </>
            );
            return row.onPress ? (
              <Pressable
                key={row.id}
                accessibilityRole="link"
                accessibilityLabel={`${row.state}: ${row.title}. ${row.kindLine}`}
                onPress={row.onPress}
                style={styles.row}
                testID={`transcript-card-row-${row.id}`}
              >
                {content}
              </Pressable>
            ) : (
              <View key={row.id} style={styles.row} testID={`transcript-card-row-${row.id}`}>
                {content}
              </View>
            );
          })}
        </View>
      ) : null}
      {hasFooter ? (
        <View style={styles.footer}>
          {footerNote !== undefined ? (
            <Text
              testID={footerNoteTestID}
              style={[styles.footerNote, footerNoteTone === 'failed' && styles.footerNoteFailed]}
            >
              {footerNote}
            </Text>
          ) : (
            <View style={styles.footerSpacer} />
          )}
          <View style={styles.actions}>
            {actions.map((action) => (
              <Pressable
                key={`${action.label}-${action.testID ?? ''}`}
                accessibilityRole={action.accessibilityRole ?? 'button'}
                accessibilityLabel={action.label}
                disabled={action.disabled}
                hitSlop={12}
                onPress={action.onPress}
                testID={action.testID}
              >
                <Text style={[styles.action, action.primary && styles.actionPrimary]}>
                  {action.loading ? '…' : action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Brass inline text for handles embedded in a card title or subline. */
export function TranscriptCardHandle({
  children,
  meta = false,
}: {
  children: ReactNode;
  meta?: boolean;
}) {
  return <Text style={meta ? styles.handleMeta : styles.handle}>{children}</Text>;
}

const styles = StyleSheet.create((theme) => {
  const card = theme.buzz;
  const metric = card.transcriptCard;
  return {
    frame: {
      minWidth: 0,
      marginTop: metric.marginTop,
      marginBottom: metric.marginBottom,
      borderWidth: 1,
      borderColor: card.border,
      borderRadius: metric.cornerRadius,
      overflow: 'hidden',
    },
    ask: { backgroundColor: card.bgRaised, borderColor: card.borderStrong },
    head: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingTop: metric.headTop,
      paddingHorizontal: metric.side,
    },
    identity: { width: metric.identitySize },
    headCopy: { flex: 1, minWidth: 0 },
    titleLine: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: card.space.sm,
    },
    title: { ...card.type.bodyStrong, color: card.textPrimary, flex: 1, minWidth: 0 },
    handle: { ...card.type.body, fontFamily: card.proseMedium, color: card.accent },
    handleMeta: { ...card.type.meta, fontFamily: card.proseMedium, color: card.accent },
    stamp: {
      ...card.type.machine,
      color: card.ledgerQuiet,
      fontVariant: ['tabular-nums'],
    },
    subline: { ...card.type.meta, color: card.ledgerQuiet, marginTop: 2 },
    body: {
      ...card.type.body,
      color: card.textSecondary,
      fontSize: metric.bodySize,
      lineHeight: metric.bodyLineHeight,
      paddingTop: card.space.sm,
      paddingHorizontal: metric.side,
    },
    bodyQuiet: { color: card.ledgerQuiet },
    code: {
      marginTop: metric.codeTop,
      marginHorizontal: metric.side,
      paddingVertical: metric.codeVertical,
      paddingHorizontal: metric.codeHorizontal,
      gap: card.space.xs,
      borderRadius: metric.codeRadius,
      backgroundColor: card.bgHighlight,
    },
    askCode: { backgroundColor: card.bgPressed },
    codePath: { ...card.type.machine, fontSize: metric.codePathSize, color: card.ledgerQuiet },
    codeText: { ...card.type.machine, color: card.textSecondary },
    rows: { marginTop: metric.rowVertical },
    row: {
      minWidth: 0,
      flexDirection: 'row',
      paddingVertical: metric.rowVertical,
      paddingHorizontal: metric.side,
      borderTopWidth: 1,
      borderTopColor: card.border,
    },
    rowState: {
      ...card.type.sectionHead,
      fontFamily: card.monoRegular,
      color: card.ledgerQuiet,
      width: metric.rowStateWidth,
    },
    rowStateWaiting: { color: card.accent },
    rowStateFailed: { color: card.diffRemoved },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: {
      ...card.type.body,
      minWidth: 0,
      fontSize: metric.rowTitleSize,
      color: card.textPrimary,
    },
    rowKind: { ...card.type.machine, fontSize: metric.rowKindSize, color: card.ledgerGhost },
    footer: {
      minHeight: metric.footerMinHeight,
      marginTop: metric.footerTop,
      paddingVertical: metric.footerVertical,
      paddingHorizontal: metric.side,
      borderTopWidth: 1,
      borderTopColor: card.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: card.space.sm,
    },
    footerSpacer: { flex: 1 },
    footerNote: {
      ...card.type.sectionHead,
      fontFamily: card.monoRegular,
      color: card.ledgerQuiet,
      flex: 1,
    },
    footerNoteFailed: { color: card.diffRemoved },
    actions: { flexDirection: 'row', alignItems: 'center', gap: metric.actionGap },
    action: { ...card.type.body, fontSize: metric.actionSize, color: card.ledgerQuiet },
    actionPrimary: { fontFamily: card.proseMedium, color: card.accent },
  };
});
