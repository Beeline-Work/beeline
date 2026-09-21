import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import { ToolOutputSheet } from '@/components/buzz/ToolOutputSheet';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

export const PEEK_LINE_COUNT = 4;
const PLAIN_TEXT_LANGUAGES = new Set(['text', 'txt', 'plaintext', 'markdown', 'md']);

export function isPlainTextFence(language: string | null) {
  const normalized = language?.trim().toLowerCase();
  return !normalized || PLAIN_TEXT_LANGUAGES.has(normalized);
}

export function fenceByteLength(code: string): number {
  return new TextEncoder().encode(code).length;
}

export function formatFenceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${Math.round(kb * 10) / 10} KB`;
  return `${Math.round(kb)} KB`;
}

export function fenceInscription(language: string | null, code: string): string {
  const lines = code.split('\n').length;
  const lang = (language?.trim() || 'text').toLowerCase();
  const lineLabel = lines === 1 ? '1 line' : `${lines} lines`;
  return `${lang} · ${lineLabel} · ${formatFenceBytes(fenceByteLength(code))}`;
}

export function isLongFence(code: string): boolean {
  return code.split('\n').length > PEEK_LINE_COUNT;
}

export function hiddenLineLabel(lineCount: number): string {
  const hidden = Math.max(0, lineCount - PEEK_LINE_COUNT);
  return hidden === 1 ? '1 more line' : `${hidden} more lines`;
}

export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [opened, setOpened] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = useMemo(() => code.split('\n'), [code]);
  const plainText = isPlainTextFence(language);
  const long = isLongFence(code);
  const inscription = useMemo(() => fenceInscription(language, code), [language, code]);
  const peek = useMemo(
    () => (long ? lines.slice(0, PEEK_LINE_COUNT).join('\n') : code),
    [code, lines, long],
  );
  const hidden = hiddenLineLabel(lines.length);
  const sheetTitle = (language?.trim() || (plainText ? 'text' : 'code')).toLowerCase();

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copyAll = useCallback(async () => {
    try {
      await (await import('expo-clipboard')).setStringAsync(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 2_000);
  }, [code]);

  const copyLabel =
    copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'copy';

  const body = plainText ? (
    <Text selectable style={styles.plainText} testID="plain-text-fence">
      {peek}
    </Text>
  ) : (
    <CodeHighlighter code={peek} language={language} />
  );

  return (
    <View style={styles.frame}>
      {long ? (
        <View style={styles.inscription}>
          <Text numberOfLines={1} style={styles.inscriptionText} testID="code-inscription">
            {inscription}
          </Text>
          <Pressable
            accessibilityLabel={plainText ? 'Copy all text' : 'Copy all code'}
            accessibilityRole="button"
            hitSlop={8}
            onPress={copyAll}
            style={({ pressed }) => [styles.verb, pressed && styles.verbPressed]}
          >
            <Text accessibilityLiveRegion="polite" style={styles.verbText}>
              {copyLabel}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.copySlot} pointerEvents="box-none">
          <Pressable
            accessibilityLabel={plainText ? 'Copy all text' : 'Copy all code'}
            accessibilityRole="button"
            hitSlop={8}
            onPress={copyAll}
            style={({ pressed }) => [styles.verb, pressed && styles.verbPressed]}
          >
            <Text accessibilityLiveRegion="polite" style={styles.verbText}>
              {copyLabel}
            </Text>
          </Pressable>
        </View>
      )}
      {long ? (
        <Pressable
          accessibilityLabel={`Open ${sheetTitle}, ${hidden}`}
          accessibilityRole="button"
          accessibilityState={{ expanded: opened }}
          onPress={() => setOpened(true)}
          style={({ pressed }) => [styles.peek, pressed && styles.peekPressed]}
          testID="code-open"
        >
          {body}
          <View style={styles.moreRow}>
            <ChevronGlyph
              color={styles.openVerb.color}
              direction="down"
              size={CHEVRON_ROW_SIZE}
            />
            <Text style={styles.openVerb}>open</Text>
            <Text style={styles.moreCount}>{hidden}</Text>
          </View>
        </Pressable>
      ) : (
        body
      )}
      <ToolOutputSheet
        detail={code}
        language={plainText ? undefined : language}
        onClose={() => setOpened(false)}
        subtitle={inscription}
        title={sheetTitle}
        visible={opened}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    maxWidth: '100%',
    minWidth: 0,
    paddingLeft: theme.buzz.space.sm,
    paddingRight: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.xs,
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.syntaxStructure,
  },
  inscription: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.buzz.space.sm,
    marginBottom: theme.buzz.space.sm,
  },
  inscriptionText: {
    ...theme.buzz.type.machine,
    flexShrink: 1,
    color: theme.buzz.ledgerBody,
  },
  copySlot: {
    height: 0,
    alignItems: 'flex-end',
    zIndex: 1,
  },
  verb: { justifyContent: 'center', paddingLeft: theme.buzz.space.sm },
  verbPressed: { opacity: 0.58 },
  verbText: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.accent,
  },
  peek: { minWidth: 0 },
  peekPressed: { opacity: 0.58 },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    marginTop: theme.buzz.space.xs,
    minHeight: theme.buzz.space.lg,
  },
  openVerb: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.accent,
  },
  moreCount: {
    ...theme.buzz.type.machine,
    color: theme.buzz.syntaxStructure,
  },
  plainText: {
    ...theme.buzz.type.machine,
    width: '100%',
    minWidth: 0,
    flexShrink: 1,
    color: theme.buzz.textPrimary,
  },
}));
