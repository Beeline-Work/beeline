import React, { useCallback, useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { parseMarkdown, type MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

type MonoMarkdownTone = 'reasoning' | 'output' | 'final';

type MonoMarkdownProps = {
  markdown: string;
  tone?: MonoMarkdownTone;
  /** Overrides the tone's canned text style — for callers embedding markdown into an existing bubble/text style instead of one of the fixed tones. */
  textStyle?: TextStyle;
  testID?: string;
};

function spanStyle(span: MarkdownSpan, base: TextStyle) {
  return [
    base,
    span.styles.includes('bold') && styles.bold,
    span.styles.includes('semibold') && styles.bold,
    span.styles.includes('italic') && styles.italic,
    span.styles.includes('code') && styles.inlineCode,
    span.url && styles.link,
  ];
}

function InlineMarkdown({
  spans,
  base,
  onLink,
}: {
  spans: MarkdownSpan[];
  base: TextStyle;
  onLink: (url: string) => void;
}) {
  return (
    <>
      {spans.map((span, index) => (
        <Text
          key={`${span.text}-${index}`}
          onPress={span.url ? () => onLink(span.url!) : undefined}
          style={spanStyle(span, base)}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

function toneTextStyle(tone: MonoMarkdownTone): TextStyle {
  if (tone === 'reasoning') return styles.reasoningText;
  if (tone === 'final') return styles.finalText;
  return styles.outputText;
}

/** Compact markdown for the Mono Hull transcript, with real hierarchy and no raw syntax. */
export function MonoMarkdown({ markdown, tone = 'output', textStyle, testID }: MonoMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const base = textStyle ?? toneTextStyle(tone);
  const onLink = useCallback((url: string) => {
    if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
  }, []);

  return (
    <View style={styles.root} testID={testID}>
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        const blockStyle = [styles.block, last && styles.lastBlock];

        if (block.type === 'text') {
          return (
            <Text key={index} selectable style={[base, blockStyle]}>
              <InlineMarkdown spans={block.content} base={base} onLink={onLink} />
            </Text>
          );
        }
        if (block.type === 'header') {
          return (
            <Text key={index} selectable style={[base, styles.heading, blockStyle]}>
              <InlineMarkdown spans={block.content} base={base} onLink={onLink} />
            </Text>
          );
        }
        if (block.type === 'list' || block.type === 'numbered-list') {
          return (
            <View key={index} style={[styles.list, blockStyle]}>
              {block.items.map((item, itemIndex) => (
                <View
                  key={itemIndex}
                  style={[styles.listRow, { paddingLeft: Math.max(0, item.depth) * 12 }]}
                >
                  <Text style={[base, styles.listGlyph]}>
                    {'number' in item ? `${item.number}.` : '·'}
                  </Text>
                  <Text selectable style={[base, styles.listText]}>
                    <InlineMarkdown spans={item.spans} base={base} onLink={onLink} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.type === 'code-block' || block.type === 'mermaid') {
          const code = block.content;
          return (
            <View key={index} style={[styles.codeFrame, blockStyle]}>
              {'language' in block && block.language ? (
                <Text style={styles.codeLanguage}>{block.language}</Text>
              ) : null}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={styles.codeBlock}>
                  {code}
                </Text>
              </ScrollView>
            </View>
          );
        }
        if (block.type === 'horizontal-rule') {
          return <View key={index} style={[styles.rule, blockStyle]} />;
        }
        if (block.type === 'table') {
          const rows = [block.headers, ...block.rows]
            .map((row) => row.map((cell) => cell.map((span) => span.text).join('')).join('  |  '))
            .join('\n');
          return (
            <ScrollView
              horizontal
              key={index}
              showsHorizontalScrollIndicator={false}
              style={[styles.codeFrame, blockStyle]}
            >
              <Text selectable style={styles.codeBlock}>
                {rows}
              </Text>
            </ScrollView>
          );
        }
        if (block.type === 'options') {
          return (
            <Text key={index} selectable style={[base, blockStyle]}>
              {block.items.map((item) => `· ${item}`).join('\n')}
            </Text>
          );
        }
        if (block.type === 'image') {
          return (
            <Text
              key={index}
              style={[base, styles.link, blockStyle]}
              onPress={() => onLink(block.url)}
            >
              {block.alt || block.url}
            </Text>
          );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', minWidth: 0 },
  block: { marginBottom: 7 },
  lastBlock: { marginBottom: 0 },
  reasoningText: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  outputText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  finalText: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 14,
    lineHeight: 21,
  },
  bold: { ...Typography.default('semiBold'), fontWeight: '700', color: groknight.textPrimary },
  italic: { fontStyle: 'italic' },
  inlineCode: { ...Typography.mono(), color: groknight.textSecondary, fontSize: 12 },
  link: { textDecorationLine: 'underline' },
  heading: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontWeight: '700',
    marginTop: 3,
  },
  list: { width: '100%', gap: 3 },
  listRow: { minWidth: 0, flexDirection: 'row', alignItems: 'flex-start' },
  listGlyph: { width: 18, color: groknight.textMuted },
  listText: { flex: 1, minWidth: 0 },
  codeFrame: {
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
    backgroundColor: groknight.bgHover,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  codeLanguage: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    marginBottom: 5,
  },
  codeBlock: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  rule: { height: 1, backgroundColor: groknight.borderQuiet, marginVertical: 3 },
});
