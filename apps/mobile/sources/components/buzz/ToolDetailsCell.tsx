import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from './SettingsRow';

/**
 * ToolDetailsCell — the ONE expandable/collapsible tool row for the
 * Workbench tool list (shared by the Trusty Squire cell and the Coinbase
 * Wallet cell; a second divergent expandable implementation is a
 * regression, not a variant).
 *
 * Collapsed it is exactly a `SettingsRow`, with no disclosure glyph competing
 * with its state/action. Tapping the row reveals the tool's existing one-line
 * capability copy beneath it.
 *
 * Controlled or uncontrolled: pass `expanded`/`onToggle` to lift the state
 * (a parent that shows one tool's details at a time), or neither to let the
 * cell own it.
 */
export type ToolDetailsCellProps = {
  action?: string;
  actionDisabled?: boolean;
  actionTestID?: string;
  detailText: string;
  errorText?: string;
  extraActions?: readonly {
    label: string;
    onPress: () => void;
    testID: string;
    tone?: 'action' | 'destructive';
    disabled?: boolean;
  }[];
  onAction?: () => void;
  value?: string;
  /** Tone for the trailing value (an erroring tool reads danger, work in
   *  flight reads accent). */
  valueTone?: 'danger' | 'accent';
  expanded?: boolean;
  onToggle?: (expanded: boolean) => void;
  testID: string;
  title: string;
};

export function ToolDetailsCell({
  action,
  actionDisabled,
  actionTestID,
  detailText,
  errorText,
  extraActions,
  onAction,
  value,
  valueTone,
  expanded: expandedProp,
  onToggle,
  testID,
  title,
}: ToolDetailsCellProps) {
  const [expandedState, setExpandedState] = useState(false);
  const expanded = expandedProp ?? expandedState;
  const toggle = () => {
    const next = !expanded;
    setExpandedState(next);
    onToggle?.(next);
  };
  return (
    <View testID={testID}>
      <SettingsRow
        action={action}
        description={errorText}
        descriptionTone={errorText ? 'danger' : undefined}
        onPress={toggle}
        testID={`${testID}-head`}
        title={title}
        value={value}
        valueTone={valueTone}
        trailingPress={
          action && onAction
            ? {
                accessibilityLabel: action,
                ...(actionDisabled !== undefined ? { disabled: actionDisabled } : {}),
                onPress: onAction,
                testID: actionTestID,
              }
            : undefined
        }
      />
      {expanded ? (
        <View style={styles.body} testID={`${testID}-details`}>
          <Text style={styles.detailLine}>{detailText}</Text>
          {extraActions?.map((entry) => (
            <SettingsRow
              disabled={entry.disabled}
              key={entry.testID}
              onPress={entry.onPress}
              testID={entry.testID}
              title={entry.label}
              tone={entry.tone}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    body: {
      paddingBottom: hull.space.md,
      paddingLeft: hull.space.xl,
      paddingRight: hull.space.sm,
      paddingTop: hull.space.sm,
    },
    detailLine: { ...hull.type.meta, color: hull.textSecondary },
  };
});
