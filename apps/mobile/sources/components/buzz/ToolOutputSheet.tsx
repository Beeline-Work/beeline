import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HULL_SHEET_INSET, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { CodeHighlighter } from './CodeHighlighter';

export type ToolOutputSheetProps = {
  title: string;
  subtitle?: string;
  detail: string | null | undefined;
  /**
   * When set (including `null` for an unlabeled fence), render Two Inks and
   * wrap. Omitted for tool output, which stays plain wrapped machine text.
   */
  language?: string | null;
  visible: boolean;
  onClose: () => void;
  copyMetadata?: string;
  testID?: string;
};

/**
 * The one output surface: title, optional subtitle, a scrollable selectable
 * wrapping body, and a Copy row. Fenced code reuses this sheet so a long
 * fence opens the same place a tool call does (C88 / C-over-B).
 */
export function ToolOutputSheet({
  title,
  subtitle,
  detail,
  language,
  visible,
  onClose,
  copyMetadata,
  testID = 'tool-output-sheet',
}: ToolOutputSheetProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    if (!detail) return;
    try {
      await (await import('expo-clipboard')).setStringAsync(detail);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [detail]);
  const highlight = language !== undefined;
  return (
    <HullActionSheetModal
      onClose={onClose}
      subtitle={subtitle}
      testID={testID}
      title={title}
      visible={visible}
    >
      <ScrollView contentContainerStyle={styles.sheetContent} style={styles.sheetScroll}>
        {highlight ? (
          <CodeHighlighter code={detail ?? ''} language={language} />
        ) : (
          <Text selectable style={styles.sheetOutput} testID="tool-output-text">
            {detail}
          </Text>
        )}
      </ScrollView>
      <HullActionSheetRow
        label="Copy output"
        metadata={copied ? 'Copied' : copyMetadata}
        onPress={copy}
        testID="tool-output-copy"
      />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    sheetScroll: { flexGrow: 0, flexShrink: 1 },
    sheetContent: { paddingHorizontal: HULL_SHEET_INSET },
    sheetOutput: {
      ...groknight.type.machine,
      width: '100%',
      minWidth: 0,
      flexShrink: 1,
      color: groknight.ledgerBody,
    },
  };
});
