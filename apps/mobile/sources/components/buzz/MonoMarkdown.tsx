import React, { useCallback, useMemo } from 'react';
import { Linking, ScrollView, Text, View, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { parseMarkdown, type MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { Typography } from '@/constants/Typography';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';

/**
 * A span split out of plain prose by `glossMentions` — the same MarkdownSpan
 * plus a mention flag. Kept local to this file: the parser above knows
 * nothing about mentions, and it must stay that way.
 */
type MentionSpan = MarkdownSpan & { mention?: boolean };

/**
 * A tagged identity in prose: `@` followed by a handle token (letters,
 * digits, `_`, `-` — the same character class the composer's mention picker
 * writes). Speakeasy's chat renders a tagged handle in accent brass; this is
 * Beeline's mapping of that effect onto the theme's own brass token.
 *
 * Deliberately narrow:
 *  - Plain prose only. Never inside code spans or links — a fenced block or a
 *    URL is machine text, not an address.
 *  - The character before `@` must be absent or non-handle text (whitespace,
 *    opening punctuation), so an email address (`user@example.com`) never
 *    glosses its domain.
 */
const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function glossMentions(
  spans: MarkdownSpan[],
  liveMentionHandles: ReadonlySet<string> = new Set(),
): MentionSpan[] {
  const out: MentionSpan[] = [];
  for (const span of spans) {
    if (span.url || span.styles.includes('code')) {
      out.push(span);
      continue;
    }
    const text = span.text;
    let last = 0;
    for (const match of text.matchAll(MENTION_PATTERN)) {
      const at = match.index ?? 0;
      const before = at > 0 ? text[at - 1]! : '';
      if (/[A-Za-z0-9_.-]/.test(before)) continue;
      const handle = (match[1] ?? '').normalize('NFKC').toLocaleLowerCase();
      if (!liveMentionHandles.has(handle)) continue;
      if (at > last) out.push({ ...span, text: text.slice(last, at) });
      out.push({ ...span, text: match[0], mention: true });
      last = at + match[0].length;
    }
    if (last === 0) out.push(span);
    else if (last < text.length) out.push({ ...span, text: text.slice(last) });
  }
  return out;
}

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
  /** Handles backed by this event's real p-tags and current Room members. */
  mentionHandles?: readonly string[];
  testID?: string;
};

/** Block kinds whose renderer starts with a `Text` that can host the handle. */
const INLINE_HOSTS = new Set(['text', 'header', 'list', 'numbered-list']);

function spanStyle(span: MentionSpan, base: TextStyle) {
  return [
    base,
    span.styles.includes('bold') && styles.bold,
    span.styles.includes('semibold') && styles.bold,
    span.styles.includes('italic') && styles.italic,
    span.styles.includes('code') && styles.inlineCode,
    span.url && styles.link,
    span.mention && styles.mention,
  ];
}

function InlineMarkdown({
  spans,
  base,
  onLink,
  liveMentionHandles,
}: {
  spans: MarkdownSpan[];
  base: TextStyle;
  onLink: (url: string) => void;
  liveMentionHandles: ReadonlySet<string>;
}) {
  // One funnel: every prose block (text, header, list items) renders its spans
  // here, so a mention glosses identically wherever it is spoken.
  const glossed = glossMentions(spans, liveMentionHandles);
  return (
    <>
      {glossed.map((span, index) => (
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
  mentionHandles,
  testID,
}: MonoMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const liveMentionHandles = useMemo(
    () =>
      new Set((mentionHandles ?? []).map((handle) => handle.normalize('NFKC').toLocaleLowerCase())),
    [mentionHandles],
  );
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
              <InlineMarkdown
                spans={block.content}
                base={base}
                onLink={onLink}
                liveMentionHandles={liveMentionHandles}
              />
            </Text>
          );
        }
        if (block.type === 'header') {
          return (
            <Text key={index} selectable style={[base, styles.heading, blockStyle]}>
              {lead}
              <InlineMarkdown
                spans={block.content}
                base={base}
                onLink={onLink}
                liveMentionHandles={liveMentionHandles}
              />
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
                  <InlineMarkdown
                    spans={item.spans}
                    base={base}
                    onLink={onLink}
                    liveMentionHandles={liveMentionHandles}
                  />
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
  // A tagged identity pops in the theme's brass — the one chromatic spend in
  // prose, shared with every other "this is addressed/live" signal.
  mention: { color: theme.buzz.accent },
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
   * A fenced block is code, not a card. The Editorial direction marks it with
   * a 2px left rule in the theme's peak steel — the same vocabulary tool
   * readouts use — so code and machine output read as one family, clearly not
   * conversation.
   */
  codeFrame: {
    maxWidth: '100%',
    paddingLeft: 13,
    paddingVertical: 3,
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.bgTexturePeak,
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
