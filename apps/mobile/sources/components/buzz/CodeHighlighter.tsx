import React, { useMemo } from 'react';
import { Text, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { tokenizeCode, type HighlightToken } from '@/buzz/syntax-highlight';

type CodeHighlighterProps = {
  code: string;
  language: string | null;
  style?: TextStyle;
};

// React Native pays native-view and layout cost for every nested Text span.
// Keep ordinary code highlighted, but render unusually large blocks as one
// selectable, full-fidelity text node instead of building thousands of spans.
const MAX_HIGHLIGHTED_CODE_CHARS = 20_000;

function tokenStyle(token: HighlightToken) {
  switch (token) {
    case 'structure':
      return styles.structure;
    case 'name':
      return styles.name;
    case 'value':
      return styles.value;
    default:
      return undefined;
  }
}

/**
 * Renders a code block with Two Inks spans. Long lines wrap: the parent must
 * bound width (no horizontal ScrollView). Very large blocks fall back to one
 * full-fidelity Text node so native layout stays bounded.
 */
export function CodeHighlighter({ code, language, style }: CodeHighlighterProps) {
  const lines = useMemo(
    () => (code.length <= MAX_HIGHLIGHTED_CODE_CHARS ? tokenizeCode(code, language) : null),
    [code, language],
  );

  if (!code) return null;

  if (!lines) {
    return (
      <Text selectable style={[styles.codeText, style]} testID="code-highlighter">
        {code}
      </Text>
    );
  }

  return (
    <Text selectable style={[styles.codeText, style]} testID="code-highlighter">
      {lines.map((line, li) => (
        <React.Fragment key={li}>
          {li > 0 ? '\n' : null}
          {line.map((span, si) => (
            <Text key={si} style={tokenStyle(span.token)}>
              {span.text}
            </Text>
          ))}
        </React.Fragment>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  codeText: {
    ...theme.buzz.type.machine,
    width: '100%',
    minWidth: 0,
    flexShrink: 1,
    color: theme.buzz.syntaxStructure,
  },
  structure: { color: theme.buzz.syntaxStructure },
  name: { color: theme.buzz.syntaxName },
  value: { color: theme.buzz.syntaxValue },
}));
