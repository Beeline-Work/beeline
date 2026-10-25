import { HULL_SHEET_INSET as sheetInset, HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';
export const HULL_SHEET_INSET = sheetInset;
import { Button } from './Button';
import React from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useIsDesktop } from '@/utils/responsive';
import { HullFloatingSurface, HullModal } from './HullDialog';
import { IndexRow } from './IndexRow';

type HullActionSheetProps = {
  desktop?: boolean;
  children: React.ReactNode;
  /** Pinned under the title: cannot scroll away with the sheet body. */
  sticky?: React.ReactNode;
  /** Navigation shown between the grip and title. */
  navigation?: React.ReactNode;
  /** Pinned under the body (Cancel). Stays on-screen while the body scrolls. */
  footer?: React.ReactNode;
  /** A virtualized child list owns scrolling for this sheet body. */
  scrollBody?: boolean;
  grip?: boolean;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  testID?: string;
  title?: string;
  /** Makes the title a button, e.g. a Room's name that opens its rename editor. */
  onTitlePress?: () => void;
  titleAccessibilityLabel?: string;
  titleTestID?: string;
};

/**
 * Bottom-sheet member of the Hull family. The surface is the same textured
 * HullSurface used by centered dialogs; a grip and hairlines carry structure.
 */
const SHEET_MAX_HEIGHT_FRACTION = 0.82;
const SHEET_GRIP_HEIGHT = 18;
const SHEET_TITLE_BLOCK = 56;
const SHEET_SUBTITLE_BLOCK = 32;
const SHEET_STICKY_BLOCK = 96;
const SHEET_FOOTER_BLOCK = 54;
const SHEET_BODY_MIN_HEIGHT = 140;
/** Space between the sheet's last control and the navigation bar (or screen edge). */
const SHEET_BOTTOM_GAP = 12;

/** The sheet draws behind the navigation bar, so clear the bar and then leave a gap. */
export function sheetBottomPadding(bottomInset: number): number {
  return bottomInset + SHEET_BOTTOM_GAP;
}

function useVisualKeyboardHeight(): number {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    if (typeof Keyboard?.addListener !== 'function') return undefined;
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      setHeight(event.endCoordinates?.height ?? 0);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return height;
}

export function HullActionSheet({
  children,
  desktop = false,
  footer,
  scrollBody = true,
  grip = true,
  navigation,
  onTitlePress,
  sticky,
  style,
  subtitle,
  testID,
  title,
  titleAccessibilityLabel,
  titleTestID,
}: HullActionSheetProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useVisualKeyboardHeight();
  const pinChrome = desktop || sticky != null || footer != null;
  const bodyMaxHeight = pinChrome
    ? Math.max(
        SHEET_BODY_MIN_HEIGHT,
        Math.round(windowHeight * SHEET_MAX_HEIGHT_FRACTION) -
          (grip ? SHEET_GRIP_HEIGHT : 0) -
          (title ? SHEET_TITLE_BLOCK : 0) -
          (subtitle ? SHEET_SUBTITLE_BLOCK : 0) -
          (sticky != null ? SHEET_STICKY_BLOCK : 0) -
          (footer != null ? SHEET_FOOTER_BLOCK : 0) -
          sheetBottomPadding(insets.bottom) -
          Math.max(keyboardHeight, 0),
      )
    : undefined;
  const body =
    pinChrome && scrollBody ? (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={[styles.bodyScroll, bodyMaxHeight != null && { maxHeight: bodyMaxHeight }]}
        testID={testID ? `${testID}-body` : undefined}
      >
        {children}
      </ScrollView>
    ) : pinChrome ? (
      <View style={[styles.bodyScroll, bodyMaxHeight != null && { maxHeight: bodyMaxHeight }]}>
        {children}
      </View>
    ) : (
      children
    );
  return (
    <HullFloatingSurface style={[styles.sheet, style]} testID={testID}>
      {grip ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.gripSlot}
        >
          <View style={styles.grip} />
        </View>
      ) : null}
      {navigation}
      {title && onTitlePress ? (
        <Pressable
          accessibilityLabel={titleAccessibilityLabel}
          accessibilityRole="button"
          onPress={onTitlePress}
          testID={titleTestID}
        >
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
        </Pressable>
      ) : title ? (
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title} testID={titleTestID}>
          {title}
        </Text>
      ) : null}
      {subtitle ? (
        <Text numberOfLines={2} style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
      {sticky}
      {body}
      {footer}
    </HullFloatingSurface>
  );
}

/**
 * The sheet row's trailing column is a closed vocabulary, and every form ends
 * on the SAME axis — the sheet's own trailing inset:
 *
 *   - `metadata`  the row's current value (a setting's state, a source name);
 *   - `toggle`    a switch, for a row that flips something on the spot;
 *   - `chevron`   for a row that opens something — `'right'` to leave for it,
 *                 `'down'` while it stands open beneath this row;
 *   - nothing     for a plain action, which acts the moment it is pressed.
 *
 * A row never invents a fifth mark, and it never wears a box: the sheet is a
 * list, so rows are parted by one hairline and nothing else (DESIGN.md → Shape).
 */
export type HullActionSheetAction = {
  accessibilityLabel?: string;
  /** The trailing chevron of a row that opens something. */
  chevron?: 'right' | 'down';
  /** The quiet line beneath the label. A full sentence never shares the
   *  label's line, so it wraps here rather than ellipsizing beside it. */
  description?: string;
  destructive?: boolean;
  disabled?: boolean;
  label: string;
  leading?: React.ReactNode;
  /** The row's current value, on the trailing axis. Never in the label. */
  metadata?: string;
  /** A row with no `onPress` and no `toggle` is a fact, not a control. */
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
  /** The trailing switch of a row that toggles. Excludes `chevron`. */
  toggle?: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
    value: boolean;
  };
};

/** The sheet preset of the one index row (`IndexRow`). */
export function HullActionSheetRow({
  description,
  destructive = false,
  label,
  metadata,
  ...props
}: HullActionSheetAction) {
  return (
    <IndexRow
      {...props}
      density="sheet"
      description={description}
      inset="sheet"
      title={label}
      tone={destructive ? 'destructive' : undefined}
      value={metadata}
    />
  );
}

export function HullActionSheetCancel({
  disabled = false,
  label = 'Cancel',
  onPress,
  testID,
}: {
  disabled?: boolean;
  label?: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Button
      label={label}
      variant="quiet"
      fullWidth
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={styles.cancel}
    />
  );
}

type HullActionSheetModalProps = {
  children: React.ReactNode;
  accessibilityLabel?: string;
  /** Widens the centred desktop sheet past the dialog cap. Only a sheet whose
   *  body is sized by its content — machine output — asks for this. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Held false while a row's inline editor has unsaved work in flight. */
  dismissOnBackdrop?: boolean;
  /** Pinned under the title. */
  sticky?: React.ReactNode;
  navigation?: React.ReactNode;
  /** Pinned under the scrolling body. */
  footer?: React.ReactNode;
  scrollBody?: boolean;
  modalTestID?: string;
  onClose: () => void;
  onDismiss?: () => void;
  scrimTestID?: string;
  testID?: string;
  title?: string;
  onTitlePress?: () => void;
  titleAccessibilityLabel?: string;
  titleTestID?: string;
  subtitle?: string;
  visible: boolean;
};

export function HullActionSheetModal({
  accessibilityLabel,
  children,
  contentStyle,
  dismissOnBackdrop,
  footer,
  scrollBody,
  modalTestID,
  navigation,
  onClose,
  onDismiss,
  onTitlePress,
  scrimTestID,
  sticky,
  subtitle,
  testID,
  title,
  titleAccessibilityLabel,
  titleTestID,
  visible,
}: HullActionSheetModalProps) {
  const insets = useSafeAreaInsets();
  const isDesktop = useIsDesktop();
  const { height: windowHeight } = useWindowDimensions();
  return (
    <HullModal
      accessibilityLabel={accessibilityLabel ?? 'Close action sheet'}
      contentStyle={[styles.modalContent, isDesktop && { maxWidth: 560 }, contentStyle, isDesktop && { maxHeight: windowHeight * SHEET_MAX_HEIGHT_FRACTION }]}
      dismissOnBackdrop={dismissOnBackdrop}
      onDismiss={onDismiss}
      onRequestClose={onClose}
      placement={isDesktop ? 'center' : 'bottom'}
      scrimTestID={scrimTestID}
      testID={modalTestID}
      visible={visible}
    >
      <HullActionSheet
        desktop={isDesktop}
        footer={footer}
        scrollBody={scrollBody}
        grip={!isDesktop}
        navigation={navigation}
        sticky={sticky}
        style={{ paddingBottom: sheetBottomPadding(insets.bottom) }}
        subtitle={subtitle}
        testID={testID}
        onTitlePress={onTitlePress}
        title={title}
        titleAccessibilityLabel={titleAccessibilityLabel}
        titleTestID={titleTestID}
      >
        {children}
      </HullActionSheet>
    </HullModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    modalContent: { paddingHorizontal: 0 },
    sheet: {
      width: '100%',
    },
    bodyScroll: {
      flexGrow: 0,
      flexShrink: 1,
    },
    gripSlot: { height: SHEET_GRIP_HEIGHT, alignItems: 'center', justifyContent: 'center' },
    grip: {
      width: 34,
      height: 3,
      borderRadius: hull.radius,
      backgroundColor: hull.textDisabled,
      opacity: 0.55,
    },
    title: {
      ...Typography.default('semiBold'),
      ...hull.type.bodyStrong,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: hull.space.xs,
      paddingBottom: hull.space.sm,
      color: hull.textPrimary,
      fontFamily: hull.proseSemibold,
    },
    subtitle: {
      ...Typography.default(),
      ...hull.type.meta,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingBottom: hull.space.sm,
      color: hull.textSecondary,
      fontFamily: hull.proseRegular,
    },
    // Cancel is one more row: the sheet row's height on the sheet's edge.
    cancel: {
      minHeight: HULL_SHEET_ROW_HEIGHT,
      paddingHorizontal: HULL_SHEET_INSET,
      alignItems: 'center',
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
  };
});
