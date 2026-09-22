import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { typeRoles } from '@/buzz/groknight';
import { HULL_SHEET_INSET, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { CodeHighlighter } from './CodeHighlighter';

/** The source line every machine body is written to. */
const OUTPUT_COLUMNS = 80;
/** IBM Plex Mono advances 600/1000 of its em, so a column is 0.6 of the size. */
const MACHINE_ADVANCE = 0.6;
/**
 * A centred desktop sheet otherwise inherits the confirm dialog's cap, which
 * is narrower than the same sheet on a phone — so the one surface that exists
 * to show machine lines wrapped them soonest on the widest screen. It is
 * measured in columns of the text it holds instead.
 */
export const TOOL_OUTPUT_SHEET_MAX_WIDTH = Math.round(
  OUTPUT_COLUMNS * MACHINE_ADVANCE * typeRoles.machine.fontSize + HULL_SHEET_INSET * 2,
);

export type ToolOutputSheetProps = {
  title: string;
  subtitle?: string;
  detail: string | null | undefined;
  /**
   * When set, render Two Inks and wrap. Omitted for ordinary tool output,
   * which stays plain wrapped machine text.
   */
  language?: string | null;
  visible: boolean;
  onClose: () => void;
  testID?: string;
};

/**
 * Tool output surface: title, optional subtitle, a scrollable selectable
 * wrapping body, and a Copy row.
 */
export function ToolOutputSheet({
  title,
  subtitle,
  detail,
  language,
  visible,
  onClose,
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
      contentStyle={styles.sheetModal}
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
      {/* The subtitle carries any context; the row reports only whether the
          press landed. */}
      <HullActionSheetRow
        label="Copy output"
        metadata={copied ? 'Copied' : undefined}
        onPress={copy}
        testID="tool-output-copy"
      />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    sheetModal: { maxWidth: TOOL_OUTPUT_SHEET_MAX_WIDTH },
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
