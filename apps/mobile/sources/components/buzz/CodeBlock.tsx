import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Href } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import {
  fenceInscription,
  hiddenLineLabel,
  isLongFence,
  isPlainTextFence,
  PEEK_LINE_COUNT,
} from '@/buzz/code-fence';
export {
  fenceByteLength,
  fenceInscription,
  formatFenceBytes,
  hiddenLineLabel,
  isLongFence,
  isPlainTextFence,
  PEEK_LINE_COUNT,
} from '@/buzz/code-fence';

export function codeArtifactHref({
  roomId,
  messageId,
  blockIndex,
}: {
  roomId: string;
  messageId: string;
  blockIndex: number;
}): Href {
  return {
    pathname: '/artifact-viewer',
    params: {
      roomId,
      messageId,
      blockIndex: String(blockIndex),
    },
  } as Href;
}

export function CodeBlock({
  code,
  language,
  roomId,
  messageId,
  blockIndex,
  onOpen,
}: {
  code: string;
  language: string | null;
  roomId?: string;
  messageId?: string;
  blockIndex?: number;
  onOpen?: (messageId: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = useMemo(() => code.split('\n'), [code]);
  const plainText = isPlainTextFence(language);
  const long = isLongFence(code);
  const routed = Boolean(roomId && messageId && blockIndex !== undefined);
  const inscription = useMemo(() => fenceInscription(language, code), [language, code]);
  const peek = useMemo(
    () => (long && routed ? lines.slice(0, PEEK_LINE_COUNT).join('\n') : code),
    [code, lines, long, routed],
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

  const openReader = useCallback(async () => {
    if (!roomId || !messageId || blockIndex === undefined) return;
    onOpen?.(messageId);
    const { router } = await import('expo-router');
    router.push(codeArtifactHref({ roomId, messageId, blockIndex }));
  }, [blockIndex, messageId, onOpen, roomId]);

  const body = plainText ? (
    <Text selectable style={styles.plainText} testID="plain-text-fence">
      {peek}
    </Text>
  ) : (
    <CodeHighlighter code={peek} language={language} />
  );

  return (
    <View style={styles.frame}>
      {long && routed ? (
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
      {long && routed ? (
        <Pressable
          accessibilityLabel={`Open ${sheetTitle}, ${hidden}`}
          accessibilityRole="button"
          onPress={openReader}
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
