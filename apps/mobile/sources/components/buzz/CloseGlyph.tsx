import React from 'react';
import type { Insets, PressableProps, StyleProp, ViewStyle } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { chromeStrokeWidth } from './MembersGlyph';

/** The one size every close and remove control draws its cross at. */
export const CLOSE_GLYPH_SIZE = 16;

/**
 * The shared close / remove mark: two crossed strokes drawn as a shape in a
 * fixed box. The characters it replaces (`✕`, `×`) came from whatever face
 * the surface happened to set, so every sheet, pane and chip drew its close
 * at a different size and weight.
 */
export function CloseGlyph({
  color,
  size = CLOSE_GLYPH_SIZE,
  testID,
}: {
  color?: string;
  size?: number;
  testID?: string;
}) {
  const stroke = color ?? styles.ink.color;
  const strokeWidth = chromeStrokeWidth(size);
  return (
    <Svg {...DECORATIVE_GLYPH_PROPS} height={size} testID={testID} viewBox="0 0 24 24" width={size}>
      <Line stroke={stroke} strokeLinecap="round" strokeWidth={strokeWidth} x1={6} x2={18} y1={6} y2={18} />
      <Line stroke={stroke} strokeLinecap="round" strokeWidth={strokeWidth} x1={18} x2={6} y1={6} y2={18} />
    </Svg>
  );
}

/**
 * The one close control: a quiet 44 pt icon button around `CloseGlyph`.
 * `control` keeps an existing approved box (a chip's corner, a composer
 * row's remove target) around the same cross; it never changes the cross.
 */
export function CloseButton({
  accessibilityLabel,
  onPress,
  testID,
  disabled,
  style,
  color,
  control,
  hitSlop,
}: {
  accessibilityLabel: string;
  onPress: PressableProps['onPress'];
  testID?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  color?: string;
  control?: PressableProps['style'];
  hitSlop?: number | Insets;
}) {
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      appearance={control ? { control, label: undefined } : undefined}
      disabled={disabled}
      hitSlop={hitSlop}
      icon={<CloseGlyph color={color} />}
      iconOnly
      label=""
      onPress={onPress}
      style={style}
      testID={testID}
      variant="quiet"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  ink: { color: theme.buzz.steel },
}));
