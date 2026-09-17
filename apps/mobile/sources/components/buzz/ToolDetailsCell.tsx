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
 * Collapsed it is exactly a `SettingsRow` with a down chevron. Expanded it
 * reveals a detail body under the same hairline rhythm — the value
 * proposition of the tool as a small list of named facts, plus any affordance
 * the tool needs (`children`, e.g. a Connect action). No box: the expansion
 * reads as indentation under the row, the way the theme wraps nothing the
 * user need not act on.
 *
 * Controlled or uncontrolled: pass `expanded`/`onToggle` to lift the state
 * (a parent that shows one tool's details at a time), or neither to let the
 * cell own it.
 */
export type ToolDetailsCellProps = {
  /** Named facts of the expanded body, each rendered as `NAME — line`. */
  details?: readonly { readonly name: string; readonly line: string }[];
  /** Affordances under the facts (a Connect button, a link row). */
  children?: React.ReactNode;
  value?: string;
  /** Tone for the trailing value (an erroring tool reads danger). */
  valueTone?: 'danger';
  description?: string;
  expanded?: boolean;
  leading?: React.ReactNode;
  onToggle?: (expanded: boolean) => void;
  testID: string;
  title: string;
};

export function ToolDetailsCell({
  children,
  value,
  valueTone,
  description,
  details,
  expanded: expandedProp,
  leading,
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
        chevron={expanded ? 'up' : 'down'}
        description={description}
        onPress={toggle}
        testID={`${testID}-head`}
        title={title}
        value={value}
        valueTone={valueTone}
      />
      {expanded ? (
        <View style={styles.body} testID={`${testID}-details`}>
          {(details ?? []).map((detail) => (
            <View key={detail.name} style={styles.detail}>
              <Text style={styles.detailName}>{detail.name}</Text>
              <Text style={styles.detailLine}>{detail.line}</Text>
            </View>
          ))}
          {children ? <View style={styles.actions}>{children}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    body: {
      gap: hull.space.sm,
      paddingBottom: hull.space.md,
      paddingLeft: hull.space.xl,
      paddingRight: hull.space.sm,
      paddingTop: hull.space.sm,
    },
    detail: { gap: 2 },
    detailName: { ...hull.type.meta, color: hull.textPrimary },
    detailLine: { ...hull.type.meta, color: hull.textSecondary },
    actions: { marginTop: hull.space.xs },
  };
});
