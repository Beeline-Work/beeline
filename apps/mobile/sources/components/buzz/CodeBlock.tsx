import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import { Typography } from '@/constants/Typography';

const COLLAPSED_LINE_COUNT = 12;
const EXPANDED_MAX_HEIGHT = 480;

export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = useMemo(() => code.split('\n'), [code]);
  const canExpand = lines.length > COLLAPSED_LINE_COUNT;
  const visibleCode = !canExpand || expanded
    ? code
    : lines.slice(0, COLLAPSED_LINE_COUNT).join('\n');

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copyAll = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 2_000);
  }, [code]);

  const copyLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy all';

  return (
    <View style={styles.frame}>
      <View style={styles.toolbar}>
        <Text numberOfLines={1} style={styles.language}>
          {language || 'code'}
        </Text>
        <View style={styles.actions}>
          {canExpand ? (
            <Pressable
              accessibilityLabel={expanded ? 'Collapse code block' : `Expand code block, ${lines.length} lines`}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              hitSlop={8}
              onPress={() => setExpanded((value) => !value)}
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            >
              <Text style={styles.actionText}>{expanded ? 'Collapse' : `Show all ${lines.length} lines`}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Copy all code"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => void copyAll()}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          >
            <Text accessibilityLiveRegion="polite" style={styles.actionText}>{copyLabel}</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView
        nestedScrollEnabled
        scrollEnabled={expanded && canExpand}
        showsVerticalScrollIndicator={expanded && canExpand}
        style={expanded && canExpand ? styles.expandedViewport : undefined}
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <CodeHighlighter code={visibleCode} language={language} />
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    maxWidth: '100%',
    paddingLeft: 13,
    paddingVertical: 3,
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.bgTexturePeak,
  },
  toolbar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  language: {
    ...Typography.mono(),
    flexShrink: 1,
    color: theme.buzz.ledgerGhost,
    fontSize: 9,
    lineHeight: 12,
  },
  actions: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  actionPressed: { opacity: 0.58 },
  actionText: {
    ...Typography.mono(),
    color: theme.buzz.ledgerQuiet,
    fontSize: 10,
    lineHeight: 14,
  },
  expandedViewport: { maxHeight: EXPANDED_MAX_HEIGHT },
}));
