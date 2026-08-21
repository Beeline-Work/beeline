import React, { useCallback, useMemo } from 'react';
import { Linking, ScrollView, Text, View, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { parseMarkdown, type MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { Typography } from '@/constants/Typography';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';

type MonoMarkdownProps = {
  markdown: string;
  /**
   * The caller's own body style. Required in practice: the ledger owns every
   * transcript text tone (`components/buzz/Ledger.tsx`), so this component no
   * longer carries canned tones of its own.
   */
  textStyle: TextStyle;
  /**
   * A node set as the very first inline child of the first text block — the
   * ledger's speaker handle, so an entry reads as one log line (handle, then
   * the words, wrapping beneath) instead of a name on its own row.
   *
   * It is nested *inside* the paragraph's `Text` rather than placed beside it,
   * which is both what makes it wrap as part of the sentence and what keeps it
   * clear of the Android bug where a `flex: 1` `Text` holding only other `Text`
   * inside a row `View` lays out at zero height.
   *
   * When the first block cannot host an inline child (a fence, a rule, a table
   * opening the message), it falls back to its own line above the content.
   */
  leadingInline?: React.ReactNode;
  testID?: string;
};

/** Block kinds whose renderer starts with a `Text` that can host the handle. */
const INLINE_HOSTS = new Set(['text', 'header', 'list', 'numbered-list']);

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
  leadingInline,
  testID,
}: MonoMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const base = textStyle;
  const onLink = useCallback((url: string) => {
    if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
  }, []);
  const first = blocks[0];
  const inlineHosted =
    Boolean(leadingInline) &&
    Boolean(first) &&
    INLINE_HOSTS.has(first.type) &&
    !('items' in first && first.items.length === 0);

  return (
    <View style={styles.root} testID={testID}>
      {leadingInline && !inlineHosted ? (
        <Text selectable style={[base, styles.block]}>
          {leadingInline}
        </Text>
      ) : null}
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        const blockStyle = [styles.block, last && styles.lastBlock];
        const lead = inlineHosted && index === 0 ? leadingInline : null;

        if (block.type === 'text') {
          return (
            <Text key={index} selectable style={[base, blockStyle]}>
              {lead}
              <InlineMarkdown spans={block.content} base={base} onLink={onLink} />
            </Text>
          );
        }
        if (block.type === 'header') {
          return (
            <Text key={index} selectable style={[base, styles.heading, blockStyle]}>
              {lead}
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
                  {itemIndex === 0 ? lead : null}
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
          const language = 'language' in block ? block.language ?? null : null;
          return (
            <View key={index} style={[styles.codeFrame, blockStyle]}>
              {'language' in block && block.language ? (
                <Text style={styles.codeLanguage}>{block.language}</Text>
              ) : null}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <CodeHighlighter code={code} language={language} />
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

const styles = StyleSheet.create((theme) => ({
  root: { width: '100%', minWidth: 0 },
  block: { marginBottom: theme.buzz.name === 'ledger' ? 4 : 8 },
  lastBlock: { marginBottom: 0 },
  /**
   * Emphasis is a luminance step, never a heavier cut.
   *
   * Bold fought the inscribed feel — on a black slab a fat stroke reads as a
   * smear, not as importance. `**strong**` therefore climbs to the top of the
   * ledger's ladder instead: a no-op on agent output (already the brightest
   * tier) and one real step up on everything else. Same for a heading, which
   * additionally gets air and tracking rather than mass.
   */
  bold: { fontFamily: theme.buzz.proseSemibold, color: theme.buzz.ledgerBright },
  italic: { fontFamily: theme.buzz.proseItalic },
  inlineCode: { fontFamily: theme.buzz.monoRegular, color: theme.buzz.ledgerQuiet },
  link: { textDecorationLine: 'underline' },
  heading: {
    fontFamily: theme.buzz.proseSemibold,
    color: theme.buzz.ledgerBright,
    letterSpacing: 0.6,
    marginTop: 3,
  },
  list: { width: '100%', gap: 3 },
  listItem: { width: '100%' },
  listGlyph: { color: theme.buzz.ledgerQuiet },
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
    borderLeftColor: theme.buzz.border,
  },
  codeLanguage: {
    ...Typography.mono(),
    color: theme.buzz.ledgerGhost,
    fontSize: 9,
    lineHeight: 12,
    marginBottom: 5,
  },
  codeBlock: {
    ...Typography.mono(),
    color: theme.buzz.ledgerQuiet,
    fontSize: 12,
    lineHeight: 18,
  },
  rule: { height: 1, backgroundColor: theme.buzz.borderQuiet, marginVertical: 3 },
}));
