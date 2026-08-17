import React, { useCallback, useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { parseMarkdown, type MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

type MonoMarkdownProps = {
  markdown: string;
  /**
   * The caller's own body style. Required in practice: the ledger owns every
   * transcript text tone (`components/buzz/Ledger.tsx`), so this component no
   * longer carries canned tones of its own.
   */
  textStyle: TextStyle;
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

/**
 * Compact markdown for the Mono Hull transcript, with real hierarchy and no raw syntax.
 *
 * Memoized: this renders once per transcript row inside FlatList's renderItem,
 * which is recreated on every presence tick (room-enter and live updates) —
 * without this, every row's markdown-to-JSX tree gets rebuilt on updates
 * unrelated to that row's own text. Props are primitives/stable style
 * references, so a shallow compare correctly bails when this row's own
 * markdown didn't change.
 */
export const MonoMarkdown = React.memo(function MonoMarkdown({
  markdown,
  textStyle,
  testID,
}: MonoMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const base = textStyle;
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
                <Text
                  key={itemIndex}
                  selectable
                  style={[base, styles.listItem, { paddingLeft: Math.max(0, item.depth) * 12 }]}
                >
                  <Text style={styles.listGlyph}>
                    {'number' in item ? `${item.number}. ` : '· '}
                  </Text>
                  <InlineMarkdown spans={item.spans} base={base} onLink={onLink} />
                </Text>
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
});

const styles = StyleSheet.create({
  root: { width: '100%', minWidth: 0 },
  block: { marginBottom: 7 },
  lastBlock: { marginBottom: 0 },
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
  listItem: { width: '100%' },
  listGlyph: { color: groknight.textMuted },
  /**
   * A fenced block is code, not a card. It marks itself with one hairline
   * gutter and an indent — the same boxless vocabulary the rest of the
   * transcript uses — so a long snippet never lands on the slab as a lit
   * panel (DESIGN.md, "The ledger").
   */
  codeFrame: {
    maxWidth: '100%',
    paddingLeft: 10,
    paddingVertical: 2,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: groknight.border,
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
