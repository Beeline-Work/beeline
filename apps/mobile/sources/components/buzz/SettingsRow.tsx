import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/** Its own 44pt press for a trailing mark the row itself does not own. */
type SettingsRowTrailingPress = {
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
};

/** A named affordance hanging off the end of the quiet line, never the axis. */
type SettingsRowDescriptionAction = {
  accessibilityLabel?: string;
  label: string;
  onPress: () => void;
  testID?: string;
};

type SettingsRowProps = {
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link';
  /** A single action word on the trailing axis. Excludes `value`. */
  action?: string;
  /** The trailing chevron of a row that opens something. */
  chevron?: 'right' | 'down';
  /** The quiet line under the title. A full sentence wraps here rather than
   *  ellipsizing beside the title, exactly as the sheet row's does. */
  description?: string;
  descriptionAction?: SettingsRowDescriptionAction;
  disabled?: boolean;
  leading?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
  title: string;
  /**
   * What the TITLE is, when it is not simply the name of a thing:
   * `'action'` — the title is the verb, so it takes the brass every other
   * action word on the page takes; `'destructive'` — the shape the Members
   * page removes a member with; `'quiet'` — a stated absence, not a thing.
   */
  tone?: 'action' | 'destructive' | 'quiet';
  trailingPress?: SettingsRowTrailingPress;
  /** The row's current state, on the trailing axis. Never in the title. */
  value?: string;
};

/**
 * The settings list row — one primitive for the account hub and Workspace
 * Settings, cut to the Members page's own metrics (`layout.row` tall, one
 * hairline, the three tones) so the three screens read as one list.
 *
 * Its trailing column is the closed vocabulary the sheet row already carries
 * (C102), on the row's own padding edge and nothing else:
 *
 *   - `chevron`  a row that opens something — `'right'` to leave for it,
 *                `'down'` while its editor stands open beneath it;
 *   - `value`    the row's current state (pairs with `chevron`);
 *   - `action`   one word, for a row that acts on the thing it names;
 *   - nothing    for a plain fact, or for a row whose TITLE is the action —
 *                the shape the Members page removes a member with.
 *
 * A row never wears a box and never carries an explanatory paragraph.
 */
export function SettingsRow({
  accessibilityLabel,
  accessibilityRole = 'button',
  action,
  chevron,
  description,
  descriptionAction,
  disabled = false,
  leading,
  onPress,
  testID,
  title,
  tone,
  trailingPress,
  value,
}: SettingsRowProps) {
  const spoken = [value ?? action, description].filter(Boolean).join('. ');
  const trailingMark =
    action !== undefined ? (
      <Text numberOfLines={1} style={styles.action}>
        {action}
      </Text>
    ) : value !== undefined ? (
      <Text numberOfLines={1} style={styles.value}>
        {value}
      </Text>
    ) : null;
  // The trailing slot owns the width cap, not the text inside it: a percentage
  // on the text resolves against a content-sized press target and collapses.
  const trailing =
    trailingMark === null ? null : trailingPress ? (
      <TouchableOpacity
        accessibilityLabel={trailingPress.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: Boolean(trailingPress.disabled) }}
        disabled={trailingPress.disabled}
        onPress={trailingPress.onPress}
        style={[
          styles.trailingSlot,
          styles.trailingControl,
          trailingPress.disabled && styles.disabled,
        ]}
        testID={trailingPress.testID}
      >
        {trailingMark}
      </TouchableOpacity>
    ) : (
      <View style={styles.trailingSlot}>{trailingMark}</View>
    );
  const body = (
    <>
      {leading}
      <View style={styles.copy}>
        <Text
          numberOfLines={1}
          style={[
            styles.title,
            tone === 'quiet' && styles.quiet,
            tone === 'action' && styles.actionTitle,
            tone === 'destructive' && styles.destructive,
          ]}
        >
          {title}
        </Text>
        {description ? (
          <View style={styles.descriptionRow}>
            <Text numberOfLines={descriptionAction ? 1 : undefined} style={styles.description}>
              {description}
            </Text>
            {descriptionAction ? (
              <TouchableOpacity
                accessibilityLabel={descriptionAction.accessibilityLabel ?? descriptionAction.label}
                accessibilityRole="button"
                onPress={descriptionAction.onPress}
                style={styles.descriptionActionControl}
                testID={descriptionAction.testID}
              >
                <Text style={styles.descriptionAction}>{descriptionAction.label}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
      {trailing}
      {chevron ? (
        <Text accessibilityElementsHidden style={styles.chevron}>
          {chevron === 'down' ? '⌄' : '›'}
        </Text>
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View
        accessibilityLabel={accessibilityLabel ?? (spoken ? `${title}. ${spoken}` : title)}
        style={styles.row}
        testID={testID}
      >
        {body}
      </View>
    );
  }
  return (
    <TouchableOpacity
      accessibilityLabel={accessibilityLabel ?? (spoken ? `${title}. ${spoken}` : title)}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, disabled && styles.disabled]}
      testID={testID}
    >
      {body}
    </TouchableOpacity>
  );
}

/** The reserved width of a row's trailing column (DESIGN.md → Index rows). */
const TRAILING_COLUMN = 72;

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    row: {
      minHeight: hull.layout.row,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      paddingHorizontal: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    disabled: { opacity: 0.42 },
    copy: { flex: 1, minWidth: 0 },
    title: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    quiet: { color: hull.textMuted },
    actionTitle: { color: hull.accent },
    destructive: { color: hull.dialogDanger },
    descriptionRow: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    // `flex: 1` rather than a shrink: it fills the copy column, so an
    // affordance hanging off its end lands on one edge down the list instead
    // of chasing the width of each row's text.
    description: {
      ...Typography.default(),
      ...hull.type.meta,
      flex: 1,
      minWidth: 0,
      color: hull.textMuted,
    },
    descriptionActionControl: { minHeight: 44, justifyContent: 'center' },
    descriptionAction: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    // The state, on the trailing axis: quiet, whole, and capped so a long one
    // never eats the title.
    value: {
      ...Typography.default(),
      ...hull.type.meta,
      textAlign: 'right',
      color: hull.textMuted,
    },
    // The one word that acts. Brass, because acting is what brass marks — and
    // redundant with the verb itself, never the only signal.
    action: { ...Typography.default(), ...hull.type.body, textAlign: 'right', color: hull.accent },
    // The trailing column reserves its width the way the index's does, so the
    // values read down one edge and the copy beside them ends on one edge too.
    trailingSlot: {
      flexShrink: 0,
      minWidth: TRAILING_COLUMN,
      maxWidth: '50%',
      alignItems: 'flex-end',
    },
    trailingControl: { minHeight: 44, justifyContent: 'center' },
    // Right-aligned in its own column so the glyph's trailing edge lands on the
    // row's padding edge — the one axis every trailing mark shares (C99, C102).
    chevron: {
      ...Typography.default(),
      ...hull.type.hero,
      width: 16,
      textAlign: 'right',
      color: hull.textMuted,
    },
  };
});
