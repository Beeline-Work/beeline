import { ErrorBanner } from './ErrorBanner';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { typeRoles } from '@/buzz/groknight';
import { HULL_SHEET_INSET, HullActionSheetModal } from './HullActionSheet';
import { Button } from './Button';
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
  error?: string | null;
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
  error,
  language,
  visible,
  onClose,
  testID = 'tool-output-sheet',
}: ToolOutputSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
  const canCopy = Boolean(detail && detail !== 'Output hidden: contains a secret.' && detail !== 'Loading…' && !error);
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
      <ScrollView
        contentContainerStyle={styles.sheetContent}
        nestedScrollEnabled
        style={[
          styles.sheetScroll,
          { maxHeight: Math.max(0, Math.round(windowHeight * 0.82) - 130 - insets.bottom) },
        ]}
        testID="tool-output-scroll"
      >
        {error ? <ErrorBanner inline title={error} /> : highlight ? (
          <CodeHighlighter code={detail ?? ''} language={language} />
        ) : (
          <Text selectable style={styles.sheetOutput} testID="tool-output-text">
            {detail || 'No output saved'}
          </Text>
        )}
      </ScrollView>
      {canCopy ? <Button
        size="inline"
        label={copied ? 'Copied' : 'Copy output'}
        appearance={{ label: styles.copyLabel }}
        style={styles.copyRow}
        onPress={copy}
        testID="tool-output-copy"
      /> : null}
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    copyLabel: { ...groknight.type.machine, color: groknight.accent },
    copyRow: { alignSelf: 'flex-start', marginHorizontal: HULL_SHEET_INSET },
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
