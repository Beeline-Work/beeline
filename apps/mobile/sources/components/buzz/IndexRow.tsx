import React from 'react';
import {
  Pressable,
  Text,
  View,
  type ViewProps,
  type AccessibilityRole,
  type AccessibilityState,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { appBoardColors } from '@/buzz/app-board-style';
import { layout } from '@/buzz/groknight';
import { HULL_SHEET_INSET, HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';
import { Button } from './Button';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';
import { HullSwitch } from './HullSwitch';
import { StateDot } from './StateDot';

/** A horizontal composition for inline navigation and non-index layout.
 * Unlike an index entry, its children retain their own typography and targets.
 */
export function InlineRow({ style, ...props }: ViewProps) {
  return <View {...props} style={[inlineStyles.row, style]} />;
}

/** Transcript navigation keeps rich text, an optional hanging glyph, and two
 * independent destinations. Index rows intentionally reserve a different axis.
 */
export function TranscriptNavigationRow({
  children,
  leading,
  primary,
  trailing,
  singleDestination = false,
  testID,
}: {
  children: React.ReactNode;
  leading?: React.ReactNode;
  primary?: IndexRowTrailingPress;
  trailing?: IndexRowTrailingPress;
  singleDestination?: boolean;
  testID?: string;
}) {
  const chevron = (
    <View style={navigationStyles.cornerTarget}>
      <ChevronGlyph
        color={navigationStyles.chevron.color}
        direction="right"
        size={CHEVRON_ROW_SIZE}
      />
    </View>
  );
  if (singleDestination && trailing)
    return (
      <View testID={testID}>
        <Pressable
          accessibilityRole="link"
          {...trailing}
          hitSlop={{ top: 6, bottom: 6 }}
          style={({ pressed }) => [
            navigationStyles.row,
            !leading && navigationStyles.divider,
            pressed && navigationStyles.pressed,
          ]}
        >
          {leading ? <View style={navigationStyles.glyph}>{leading}</View> : null}
          <View style={navigationStyles.copyTarget}>{children}</View>
          {chevron}
        </Pressable>
      </View>
    );
  return (
    <View style={[navigationStyles.row, navigationStyles.divider]} testID={testID}>
      {primary ? (
        <Pressable accessibilityRole="link" {...primary} style={navigationStyles.copyTarget}>
          {children}
        </Pressable>
      ) : (
        <View style={navigationStyles.copyTarget}>{children}</View>
      )}
      {trailing ? (
        <Pressable accessibilityRole="link" {...trailing} style={navigationStyles.cornerTarget}>
          {chevron}
        </Pressable>
      ) : null}
    </View>
  );
}

const inlineStyles = StyleSheet.create(() => ({ row: { flexDirection: 'row' } }));
const navigationStyles = StyleSheet.create(({ buzz }) => ({
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', gap: buzz.space.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: buzz.border },
  pressed: { opacity: 0.6 },
  glyph: {
    flexShrink: 0,
    height: buzz.type.body.lineHeight,
    justifyContent: 'center',
    marginTop: buzz.space.sm,
  },
  copyTarget: { minHeight: 44, minWidth: 44, flex: 1, paddingVertical: buzz.space.sm },
  cornerTarget: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  chevron: { color: buzz.accent },
}));

/** Its own 44pt press for a trailing mark the row itself does not own. */
export type IndexRowTrailingPress = {
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
};

/** The compact bordered action control on the trailing axis: one word, boxed —
 *  the Connect button a tool row carries while it is not connected. */
export type IndexRowActionControl = {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

/** A named affordance hanging off the end of the quiet line, never the axis. */
export type IndexRowDescriptionAction = {
  accessibilityLabel?: string;
  label: string;
  onPress: () => void;
  testID?: string;
};

export type IndexRowToggle = {
  accessibilityLabel?: string;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
  value: boolean;
};

export type IndexRowProps = {
  title: string;
  /** `page` rows are `layout.row` tall; `sheet` rows are the sheet row height. */
  density?: 'page' | 'sheet';
  /** `row` aligns with page section headers; `sheet` is the sheet's own edge. */
  inset?: 'row' | 'sheet';
  /** Which edge carries the hairline. Sheets part rows above; pages below. */
  divider?: 'top' | 'bottom';
  /** Approved Workbench app-board row metrics. */
  appBoard?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  /** A single action word on the trailing axis. */
  action?: string;
  /** The compact bordered action control on the trailing axis. */
  actionControl?: IndexRowActionControl;
  /** The trailing chevron of a row that opens something. */
  chevron?: 'right' | 'down' | 'up';
  /** The quiet line under the title: one short phrase, two lines at most. */
  description?: string;
  /** A short fact kept whole before a one-line, ellipsized description tail. */
  descriptionLead?: string;
  /** Custom rendering for the description; `description` remains its spoken text. */
  descriptionContent?: React.ReactNode;
  /** A second quiet line under `description`, for one provenance fact. */
  descriptionDetail?: string;
  /** Inline marks and text for the second quiet line; descriptionDetail is its spoken text. */
  descriptionDetailContent?: React.ReactNode;
  /** A failed row may put its exact error in the subtitle. */
  descriptionTone?: 'danger';
  descriptionAction?: IndexRowDescriptionAction;
  disabled?: boolean;
  leading?: React.ReactNode;
  onPress?: () => void;
  /** Marks the chosen option in a sheet: the value reads SELECTED. */
  selected?: boolean;
  statusGlyph?: 'live' | 'pulse' | 'failed';
  testID?: string;
  /** A quiet fact at the end of the title line (an agent's model). */
  titleAside?: string;
  /**
   * What the TITLE is, when it is not simply the name of a thing:
   * `'action'` — the title is the verb, in brass; `'destructive'` — the shape
   * a member is removed with; `'quiet'` — a stated absence, not a thing.
   */
  tone?: 'action' | 'destructive' | 'quiet';
  toggle?: IndexRowToggle;
  /** Caller-owned controls for the trailing column (a roster's actions). */
  trailing?: React.ReactNode;
  trailingPress?: IndexRowTrailingPress;
  /** The row's current state, on the trailing axis. Never in the title. */
  value?: string;
  valueTone?: 'danger' | 'accent';
  /** The title keeps its full width; the trailing value ellipsizes instead. */
  wholeTitle?: boolean;
};

/** A page subtitle is one short phrase; a long one stops at two lines. */
const DESCRIPTION_LINES = 2;

/** The reserved width of a row's trailing column (DESIGN.md → Index rows). */
const TRAILING_COLUMN = 72;

/** The 44 pt tap area a quiet-line action reaches without growing the line. */
const DESCRIPTION_ACTION_SLOP = 12;

/** A described row's vertical padding and title-to-subtitle gap, from the
 *  approved roomy subtitle rows; both sit between steps of the spacing scale. */
const DESCRIBED_ROW_PADDING = 14;
const DESCRIPTION_GAP = 2;

/**
 * The one index row: Settings, sheets and member rosters. One trailing column,
 * one pressed fill, one disabled opacity, on two densities and two insets.
 *
 * The trailing column is a closed vocabulary, every form ending on the row's
 * own padding edge:
 *
 *   - `chevron`        a row that opens something;
 *   - `value`          the row's current state (pairs with `chevron` and
 *                      `statusGlyph`);
 *   - `action`         one word, for a row that acts on the thing it names;
 *   - `actionControl`  the compact bordered Connect control;
 *   - `toggle`         the one switch;
 *   - `trailing`       caller-owned controls (a roster's actions);
 *   - nothing          for a plain fact, or a row whose TITLE is the action.
 *
 * A row never wears a box and never carries an explanatory paragraph.
 */
export function IndexRow({
  appBoard = false,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  action,
  actionControl,
  chevron,
  density = 'page',
  description,
  descriptionAction,
  descriptionContent,
  descriptionDetail,
  descriptionDetailContent,
  descriptionLead,
  descriptionTone,
  disabled = false,
  divider,
  inset = 'row',
  leading,
  onPress,
  selected = false,
  statusGlyph,
  testID,
  title,
  titleAside,
  tone,
  toggle,
  trailing,
  trailingPress,
  value,
  valueTone,
  wholeTitle = false,
}: IndexRowProps) {
  const shownValue = selected ? 'SELECTED' : value;
  const spoken = [
    shownValue ?? action ?? actionControl?.label,
    descriptionLead ? `${descriptionLead} ${description ?? ''}`.trim() : description,
    descriptionDetail,
  ]
    .filter(Boolean)
    .join('. ');
  const rowLabel = accessibilityLabel ?? (spoken ? `${title}. ${spoken}` : title);
  // A pressable toggle row IS the switch to a screen reader, so the control
  // itself is not announced a second time.
  const rowIsSwitch = Boolean(toggle && onPress);
  // A page subtitle is one short phrase and stops at two lines; a sheet row's
  // quiet line explains the choice, so it wraps whole (screenshot 1cfe27eb).
  const descriptionLines = density === 'page' ? DESCRIPTION_LINES : undefined;

  const trailingMark =
    action !== undefined ? (
      <Text numberOfLines={1} style={styles.action}>
        {action}
      </Text>
    ) : shownValue !== undefined ? (
      <View style={[styles.valueRow, wholeTitle && styles.yieldingValue]}>
        {statusGlyph ? (
          <StateDot kind={statusGlyph} testID={testID ? `${testID}-glyph` : undefined} />
        ) : null}
        <Text
          numberOfLines={1}
          style={[
            styles.value,
            appBoard && styles.boardValue,
            valueTone === 'danger' && styles.valueDanger,
            valueTone === 'accent' && styles.valueAccent,
            wholeTitle && styles.yieldingValue,
          ]}
        >
          {shownValue}
        </Text>
      </View>
    ) : null;

  // The trailing slot owns the width cap, not the text inside it: a percentage
  // on the text resolves against a content-sized press target and collapses.
  const trailingColumn = toggle ? (
    <View
      accessibilityElementsHidden={rowIsSwitch}
      importantForAccessibility={rowIsSwitch ? 'no-hide-descendants' : 'auto'}
      // A pressable row is the switch's tap target; a bare switch needs its own 44.
      style={[styles.trailingSlot, !onPress && styles.trailingControl]}
    >
      <HullSwitch
        accessibilityLabel={toggle.accessibilityLabel ?? title}
        dimWhenDisabled={!disabled}
        disabled={toggle.disabled ?? disabled}
        onValueChange={toggle.onValueChange}
        testID={testID ? `${testID}-toggle` : undefined}
        value={toggle.value}
      />
    </View>
  ) : actionControl !== undefined ? (
    <View style={styles.trailingSlot}>
      <Button
        label={actionControl.label}
        variant="secondary"
        accessibilityLabel={actionControl.accessibilityLabel ?? actionControl.label}
        disabled={actionControl.disabled}
        onPress={actionControl.onPress}
        testID={actionControl.testID}
      />
    </View>
  ) : trailing !== undefined ? (
    <View style={styles.trailingSlot}>{trailing}</View>
  ) : trailingMark === null ? null : trailingPress ? (
    <Pressable
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
    </Pressable>
  ) : (
    <View style={[styles.trailingSlot, wholeTitle && styles.yieldingSlot]}>{trailingMark}</View>
  );

  const body = (
    <>
      {leading}
      <View style={[styles.copy, wholeTitle && styles.wholeCopy]}>
        <View style={styles.titleLine}>
          <Text
            numberOfLines={1}
            style={[
              styles.title,
              appBoard && styles.boardTitle,
              tone === 'quiet' && styles.quiet,
              tone === 'action' && styles.actionTitle,
              tone === 'destructive' && styles.destructive,
            ]}
          >
            {title}
          </Text>
          {titleAside ? (
            <Text numberOfLines={1} style={styles.titleAside}>
              {titleAside}
            </Text>
          ) : null}
        </View>
        {description || descriptionContent ? (
          <View style={[styles.descriptionRow, descriptionLead && styles.descriptionLeadRow]}>
            {descriptionLead ? (
              <Text
                numberOfLines={1}
                style={styles.descriptionLead}
                testID={testID ? `${testID}-description-lead` : undefined}
              >
                {descriptionLead}
              </Text>
            ) : null}
            {descriptionContent ?? (
              <Text
                numberOfLines={descriptionLead || descriptionAction ? 1 : descriptionLines}
                style={[
                  descriptionLead ? styles.descriptionTail : styles.description,
                  descriptionTone === 'danger' && styles.descriptionDanger,
                ]}
              >
                {description}
              </Text>
            )}
            {descriptionAction ? (
              <Pressable
                accessibilityLabel={descriptionAction.accessibilityLabel ?? descriptionAction.label}
                accessibilityRole="button"
                hitSlop={DESCRIPTION_ACTION_SLOP}
                onPress={descriptionAction.onPress}
                testID={descriptionAction.testID}
              >
                <Text style={styles.descriptionAction}>{descriptionAction.label}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {descriptionDetail || descriptionDetailContent ? (
          <View style={[styles.descriptionRow, Boolean(descriptionDetailContent) && styles.inlineDetail]}>
            {descriptionDetailContent ?? <Text numberOfLines={DESCRIPTION_LINES} style={styles.description}>
              {descriptionDetail}
            </Text>}
          </View>
        ) : null}
      </View>
      {trailingColumn}
      {chevron ? (
        <View style={styles.chevron}>
          <ChevronGlyph
            color={styles.chevronMark.color}
            direction={chevron}
            size={CHEVRON_ROW_SIZE}
          />
        </View>
      ) : null}
    </>
  );

  const described = Boolean(description || descriptionContent || descriptionDetail || descriptionDetailContent);
  const rowStyle = [
    styles.row,
    density === 'sheet' ? styles.sheetRow : styles.pageRow,
    inset === 'sheet' ? styles.sheetInset : styles.rowInset,
    (divider ?? (density === 'sheet' ? 'top' : 'bottom')) === 'top'
      ? styles.dividerTop
      : styles.dividerBottom,
    described && density === 'page' && styles.describedRow,
    appBoard && styles.boardRow,
  ];

  if (!onPress) {
    return (
      <View
        accessibilityLabel={rowLabel}
        accessibilityRole={accessibilityRole}
        accessibilityState={accessibilityState ?? (disabled ? { disabled } : undefined)}
        style={[rowStyle, disabled && styles.disabled]}
        testID={testID}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={rowLabel}
      accessibilityRole={accessibilityRole ?? (rowIsSwitch ? 'switch' : 'button')}
      accessibilityState={
        accessibilityState ??
        (rowIsSwitch ? { checked: toggle?.value, disabled } : { disabled, selected })
      }
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && styles.pressed, disabled && styles.disabled]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
    },
    pageRow: { minHeight: layout.row },
    sheetRow: { minHeight: HULL_SHEET_ROW_HEIGHT, paddingVertical: hull.space.sm },
    rowInset: { paddingHorizontal: hull.space.sm },
    sheetInset: { paddingHorizontal: HULL_SHEET_INSET },
    dividerTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: hull.border },
    dividerBottom: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: hull.border },
    // A page row with a subtitle keeps its text clear of both hairlines; one
    // without stays exactly its density's height.
    describedRow: { paddingVertical: DESCRIBED_ROW_PADDING },
    boardRow: {
      minHeight: layout.row,
      gap: hull.space.md,
      paddingHorizontal: 0,
      borderTopWidth: 0,
      borderBottomWidth: 1,
      borderBottomColor: board.border,
    },
    pressed: { backgroundColor: hull.bgPressed },
    disabled: { opacity: 0.42 },
    copy: { flex: 1, minWidth: 0 },
    // A whole title sizes the copy column to itself; the trailing value yields.
    wholeCopy: { flexGrow: 1, flexShrink: 0, flexBasis: 'auto' },
    yieldingSlot: { flexShrink: 1, minWidth: 0 },
    yieldingValue: { flexShrink: 1, minWidth: 0, maxWidth: '100%' },
    titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: hull.space.sm },
    title: {
      ...Typography.default(),
      ...hull.type.body,
      flexShrink: 1,
      color: hull.textPrimary,
    },
    titleAside: {
      ...Typography.default(),
      ...hull.type.meta,
      flexShrink: 0,
      marginLeft: 'auto',
      maxWidth: '60%',
      textAlign: 'right',
      color: hull.textMuted,
    },
    boardTitle: { ...Typography.default(), ...hull.type.body, color: board.ink },
    quiet: { color: hull.textMuted },
    actionTitle: { color: hull.accent },
    destructive: { color: hull.dialogDanger },
    descriptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      marginTop: DESCRIPTION_GAP,
    },
    inlineDetail: { gap: 0 },
    descriptionLeadRow: { gap: hull.space.xs },
    descriptionLead: {
      ...Typography.default(),
      ...hull.type.meta,
      flexShrink: 0,
      color: hull.textMuted,
    },
    descriptionTail: {
      ...Typography.default(),
      ...hull.type.meta,
      flex: 1,
      minWidth: 0,
      color: hull.textMuted,
    },
    // `flex: 1` fills the copy column, so an affordance hanging off its end
    // lands on one edge down the list instead of chasing each row's text.
    description: {
      ...Typography.default(),
      ...hull.type.meta,
      flex: 1,
      minWidth: 0,
      color: hull.textMuted,
    },
    descriptionDanger: { color: hull.dialogDanger },
    descriptionAction: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    value: {
      ...Typography.default(),
      ...hull.type.meta,
      textAlign: 'right',
      color: hull.textMuted,
    },
    boardValue: { ...Typography.default(), ...hull.type.meta, color: board.quiet },
    valueDanger: { color: hull.dialogDanger },
    valueAccent: { ...Typography.default('medium'), ...hull.type.meta, color: hull.accent },
    valueRow: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    // The one word that acts. Brass, because acting is what brass marks.
    action: { ...Typography.default(), ...hull.type.meta, textAlign: 'right', color: hull.accent },
    // The one trailing column: values read down one edge, and the copy beside
    // them ends on one edge too.
    trailingSlot: {
      flexShrink: 0,
      minWidth: TRAILING_COLUMN,
      maxWidth: '50%',
      alignItems: 'flex-end',
    },
    trailingControl: { minHeight: 44, justifyContent: 'center' },
    // Right-aligned in its own column so the glyph's trailing edge lands on
    // the row's padding edge — the one axis every trailing mark shares.
    chevron: { width: hull.space.md, alignItems: 'flex-end', justifyContent: 'center' },
    chevronMark: { color: hull.textMuted },
  };
});

/** Compact, wrapping facts inside a transcript card. */
export function TranscriptFactRow({ label, value }: { label: string; value: string }) {
  return <View style={factStyles.row}>
    <Text style={factStyles.label}>{label}</Text>
    <Text style={factStyles.value}>{value}</Text>
  </View>;
}
const factStyles = StyleSheet.create(({ buzz }) => ({
  row: { flexDirection: 'row', gap: buzz.space.sm, paddingVertical: buzz.space.sm, borderTopWidth: 1, borderTopColor: buzz.borderStrong },
  label: { ...buzz.type.meta, color: buzz.ledgerQuiet },
  value: { ...buzz.type.meta, color: buzz.textPrimary, flex: 1, textAlign: 'right' },
}));
