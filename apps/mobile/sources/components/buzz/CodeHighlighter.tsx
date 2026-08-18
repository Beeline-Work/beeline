import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { groknight } from '@/buzz/groknight';
import { syntaxColors, type SyntaxToken } from '@/buzz/syntax-colors';
import { tokenizeCode, type TokenizedLine, type HighlightToken } from '@/buzz/syntax-highlight';
import { Typography } from '@/constants/Typography';

type CodeHighlighterProps = {
  code: string;
  language: string | null;
  style?: TextStyle;
};

/**
 * Map a highlight-token type to a syntax-palette colour.
 */
function tokenColor(token: HighlightToken): string | undefined {
  switch (token) {
    case 'keyword': return syntaxColors.keyword;
    case 'string':
    case 'attrValue': return syntaxColors.string;
    case 'number': return syntaxColors.number;
    case 'comment': return syntaxColors.comment;
    case 'type': return syntaxColors.type;
    case 'builtin': return syntaxColors.builtin;
    case 'punctuation': return syntaxColors.punctuation;
    case 'function': return syntaxColors.function;
    case 'tag': return syntaxColors.tag;
    case 'attrName': return syntaxColors.attrName;
    default: return undefined;
  }
}

/**
 * Renders a code block with syntax-highlighted spans.
 *
 * Falls back to plain monochrome text when no language is specified or the
 * code is short/trivial — the tokeniser works on any input, but a `null`
 * language fence produces no keyword/type classification (only strings,
 * numbers, and comments get coloured) which keeps the output clean.
 */
export function CodeHighlighter({ code, language, style }: CodeHighlighterProps) {
  const lines = useMemo(() => tokenizeCode(code, language), [code, language]);

  // If the code is empty, render nothing meaningful.
  if (!code) return null;

  return (
    <Text selectable style={[styles.codeText, style]}>
      {lines.map((line, li) => (
        <Text key={li} style={styles.line}>
          {line.length === 0 ? (
            // Preserve blank lines with a space character so the Text height doesn't collapse.
            <Text>{' '}</Text>
          ) : (
            line.map((span, si) => (
              <Text key={si} style={tokenColor(span.token) ? { color: tokenColor(span.token) } : undefined}>
                {span.text}
              </Text>
            ))
          )}
          {li < lines.length - 1 ? <Text>{'\n'}</Text> : null}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  codeText: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
  line: {},
});