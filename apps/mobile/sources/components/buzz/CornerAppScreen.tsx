import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CornerAppBlock, CornerAppView } from '@beeline/api-contract/phone';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

export function CornerAppScreen({
  app,
  onBack,
  onAction,
  busyAction,
}: {
  app?: CornerAppView;
  onBack: () => void;
  onAction: (prompt: string) => void;
  busyAction?: string;
}) {
  return (
    <View style={styles.screen} testID="corner-app-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to corner"
          accessibilityRole="button"
          hitSlop={10}
          onPress={onBack}
          style={styles.back}
        >
          <ChevronGlyph
            color={styles.backText.color}
            direction="left"
            size={CHEVRON_BACK_SIZE}
          />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.title}>
            {app?.title ?? 'Corner App'}
          </Text>
          {app ? (
            <Text numberOfLines={1} style={styles.byline}>
              /{app.command} · {app.authorName}
            </Text>
          ) : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {!app ? (
          <Text style={styles.empty}>This app is not available in the corner.</Text>
        ) : (
          <>
            {app.description ? <Text style={styles.description}>{app.description}</Text> : null}
            {app.blocks.map((block, index) => (
              <CornerAppBlockView
                block={block}
                busy={block.type === 'action' && busyAction === block.prompt}
                key={`${block.type}:${index}`}
                onAction={onAction}
              />
            ))}
            <Text style={styles.revision}>Revision {app.revision} · shared with this corner</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

export function CornerAppRow({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`Open Corner App ${title}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.appRow, pressed && styles.actionPressed]}
      testID="corner-app-row"
    >
      <View style={styles.appRowCopy}>
        <Text style={styles.appRowLabel}>CORNER APP</Text>
        <Text numberOfLines={1} style={styles.appRowTitle}>
          {title}
        </Text>
      </View>
      <Text style={styles.actionArrow}>OPEN →</Text>
    </Pressable>
  );
}

function CornerAppBlockView({
  block,
  busy,
  onAction,
}: {
  block: CornerAppBlock;
  busy: boolean;
  onAction: (prompt: string) => void;
}) {
  switch (block.type) {
    case 'heading':
      return <Text style={styles.heading}>{block.text}</Text>;
    case 'text':
      return <Text style={styles.body}>{block.text}</Text>;
    case 'fields':
      return (
        <View style={styles.fields}>
          {block.items.map((item) => (
            <View key={item.label} style={styles.field}>
              <Text style={styles.fieldLabel}>{item.label}</Text>
              <Text selectable style={styles.fieldValue}>
                {item.value}
              </Text>
            </View>
          ))}
        </View>
      );
    case 'notice':
      return (
        <View
          accessibilityRole="summary"
          style={[styles.notice, block.tone === 'warning' && styles.noticeWarning]}
        >
          <Text style={styles.noticeText}>{block.text}</Text>
        </View>
      );
    case 'action':
      return (
        <Pressable
          accessibilityLabel={`${block.label}. Sends a prompt to ${block.prompt}`}
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={() => onAction(block.prompt)}
          style={({ pressed }) => [
            styles.action,
            pressed && styles.actionPressed,
            busy && styles.actionBusy,
          ]}
          testID={`corner-app-action-${block.label}`}
        >
          <Text style={styles.actionLabel}>{busy ? 'Sending…' : block.label}</Text>
          <Text style={styles.actionArrow}>→</Text>
        </Pressable>
      );
  }
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  header: {
    minHeight: 62,
    paddingRight: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.borderQuiet,
  },
  back: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  backText: { color: theme.buzz.textPrimary },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  byline: { ...theme.buzz.type.machine, color: theme.buzz.textMuted, marginTop: 2 },
  content: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 56,
  },
  description: {
    ...theme.buzz.type.body,
    color: theme.buzz.ledgerQuiet,
    marginBottom: 30,
  },
  heading: {
    ...theme.buzz.type.hero,
    color: theme.buzz.textPrimary,
    marginTop: 28,
    marginBottom: 10,
  },
  body: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    marginBottom: 18,
  },
  fields: { marginVertical: 8 },
  field: {
    paddingVertical: 12,
    flexDirection: 'row',
    gap: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.borderQuiet,
  },
  fieldLabel: {
    ...theme.buzz.type.sectionHead,
    width: 120,
    color: theme.buzz.textMuted,
    textTransform: 'uppercase',
  },
  fieldValue: {
    ...theme.buzz.type.machine,
    flex: 1,
    color: theme.buzz.textPrimary,
    textAlign: 'right',
  },
  notice: {
    marginVertical: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
  },
  noticeWarning: { borderColor: theme.buzz.accent },
  noticeText: {
    ...theme.buzz.type.body,
    color: theme.buzz.ledgerQuiet,
  },
  action: {
    minHeight: 48,
    marginTop: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: theme.buzz.accent,
    borderRadius: theme.buzz.radius,
  },
  actionPressed: { backgroundColor: theme.buzz.bgHover },
  actionBusy: { opacity: 0.6 },
  actionLabel: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  actionArrow: { ...theme.buzz.type.bodyStrong, color: theme.buzz.accent },
  revision: { ...theme.buzz.type.machine, color: theme.buzz.textMuted, marginTop: 38 },
  empty: { ...theme.buzz.type.body, color: theme.buzz.ledgerQuiet },
  appRow: {
    minHeight: 58,
    marginVertical: 6,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: 10,
  },
  appRowCopy: { flex: 1, minWidth: 0, gap: 3 },
  appRowLabel: { ...theme.buzz.type.sectionHead, color: theme.buzz.textMuted },
  appRowTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
}));
